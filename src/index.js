const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

// Se importan las librerías de Airtable.
const Airtable = require('airtable');

// Configura la aplicación Express.
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));

// Variable para almacenar el historial de la conversación.
const conversationHistory = {};

// Configura Airtable con las variables de entorno.
const airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// --- EL ENDPOINT PRINCIPAL PARA TWILIO ---
app.post('/whatsapp-webhook', (req, res) => {
    res.send('OK');
    processMessage(req.body);
});

// --- Función que procesa el mensaje en segundo plano ---
async function processMessage(body) {
    try {
        const userMessage = body.Body;
        const fromNumber = body.From;
        const toNumber = body.To;

        if (!userMessage) {
            console.log("Mensaje vacío recibido, ignorando.");
            return;
        }

        if (!conversationHistory[fromNumber]) {
            conversationHistory[fromNumber] = [];
        }

        conversationHistory[fromNumber].push({
            role: "user",
            parts: [{ text: userMessage }]
        });

        const geminiResponse = await generateGeminiResponse(conversationHistory[fromNumber]);

        if (geminiResponse) {
            conversationHistory[fromNumber].push({
                role: "model",
                parts: [{ text: geminiResponse }]
            });
            await sendTwilioResponse(fromNumber, toNumber, geminiResponse);
        }

    } catch (error) {
        console.error(`Error procesando mensaje: ${error.message}`);
        await sendTwilioResponse(body.From, body.To, "Lo siento, hubo un problema procesando tu solicitud.");
    }
}

// --- Función principal para llamar a la API de Gemini ---
async function generateGeminiResponse(history) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent";

    const systemInstructions = `Eres un asistente de citas para el consultorio oftalmológico del Doctor Lucas. Tu única función es agendar citas.

Reglas de agendamiento:
- Consultas en el consultorio: Lunes a viernes, de 8 AM a 11 AM.
- Consultas a domicilio: Lunes a viernes, de 3 PM a 7 PM.

Para agendar una cita, necesitas el nombre completo, número de teléfono, fecha y hora.

**IMPORTANTE**: Cuando tengas todos los datos ('nombre', 'telefono', 'fecha' y 'hora'), tu **única respuesta** debe ser un objeto JSON con esos campos. La fecha debe estar en formato YYYY-MM-DD.
Si el cliente envía una referencia de pago en un mensaje posterior a haber agendado su cita, debes responder con un objeto JSON con los campos 'nombre', 'telefono' y 'referenciaPago', dejando los demás campos vacíos. Esto servirá para actualizar el registro del cliente en la base de datos.
 
No respondas a preguntas médicas, de facturación o de otro tipo que no sean agendar.`;

    const payload = {
        contents: history,
        systemInstruction: {
            parts: [{ text: systemInstructions }]
        },
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 400
        },
    };

    const url = `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`;
    
    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(url, payload, {
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            const responseData = response.data;
            if (responseData && responseData.candidates && responseData.candidates.length > 0) {
                const firstCandidate = responseData.candidates[0];
                if (firstCandidate.content && firstCandidate.content.parts) {
                    for (const part of firstCandidate.content.parts) {
                        if (part.text) {
                            try {
                                const appointmentDetails = JSON.parse(part.text);
                                console.log("Se ha recibido la señal para agendar la cita y los datos JSON:", appointmentDetails);
                                await handleAppointmentFlow(appointmentDetails);
                                return "¡Excelente! Tu cita ha sido agendada con éxito. Te esperamos.";
                            } catch (e) {
                                console.log("Respuesta de Gemini recibida exitosamente, en modo conversacional.");
                                return part.text;
                            }
                        }
                    }
                }
            }
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.error(`Error 429: Demasiadas solicitudes. Reintento ${i + 1} de ${maxRetries}...`);
                const delay = Math.pow(2, i) * 10000;
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                } else {
                    console.error("Máximo de reintentos alcanzado. Fallando.");
                    throw error;
                }
            } else {
                console.error(`Error llamando a la API de Gemini: ${error.message}`);
                throw error;
            }
        }
    }

    return null;
}

// --- Nuevas Funciones para la Gestión de la Cita ---
async function handleAppointmentFlow(appointmentDetails) {
    try {
        console.log("Detalles de la cita a procesar:", appointmentDetails);

        const airtableResponse = await createAirtableRecord(appointmentDetails);
        if (airtableResponse) {
            console.log("Registro en Airtable creado con éxito.");
        }
    } catch (error) {
        console.error("Error en el flujo de agendamiento:", error);
    }
}

// Función para crear un nuevo registro en Airtable.
async function createAirtableRecord(details) {
    try {
        const table = airtableBase('Citas');
        // Combina fecha y hora en un solo campo para Airtable.
        const combinedDateTime = `${details.fecha}T${details.hora}:00Z`;

        const createdRecord = await table.create({
            "Nombre": details.nombre,
            "Teléfono": details.telefono,
            "Fecha": combinedDateTime
        });
        return createdRecord;
    } catch (error) {
        console.error("Error creando registro en Airtable:", error);
        throw error;
    }
}

// --- Función para enviar un mensaje usando la API de Twilio ---
async function sendTwilioResponse(to, from, body) {
    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const twilioApiUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
    const payload = new URLSearchParams();
    payload.append('From', from);
    payload.append('To', to);
    payload.append('Body', body);

    try {
        const response = await axios.post(twilioApiUrl, payload, {
            auth: {
                username: TWILIO_ACCOUNT_SID,
                password: TWILIO_AUTH_TOKEN
            }
        });
    } catch (error) {
        console.error(`Error enviando mensaje con Twilio: ${error.message}`);
        throw error;
    }
}

// Inicia el servidor de Express en el puerto configurado.
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});
