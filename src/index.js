// Importa las librerías necesarias.
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

// Configura la aplicación Express.
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));

// Variable para almacenar el historial de la conversación.
const conversationHistory = {};

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

        // Obtiene o inicializa el historial de conversación para el usuario actual.
        if (!conversationHistory[fromNumber]) {
            conversationHistory[fromNumber] = [];
        }

        // Agrega el nuevo mensaje del usuario al historial.
        conversationHistory[fromNumber].push({
            role: "user",
            parts: [{ text: userMessage }]
        });

        // Llama a la función de la IA y le pasa el historial de conversación.
        const geminiResponse = await generateGeminiResponse(conversationHistory[fromNumber]);

        if (geminiResponse) {
            // Agrega la respuesta del asistente al historial.
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

    // Las instrucciones del sistema le dicen a la IA cómo debe comportarse.
    const systemInstructions = "Eres un asistente de citas para un consultorio oftalmológico. Tu única función es agendar citas. No respondas a preguntas médicas, de facturación o de otro tipo que no sean agendar. En esos casos, pide amablemente que el cliente se comunique directamente con el consultorio. Cuando tengas el nombre completo, número de teléfono, fecha y hora del cliente, debes responder con el mensaje 'CITA_COMPLETADA' para que el sistema agende la cita. No uses este mensaje de respuesta antes de tener todos los datos.";

    const payload = {
        contents: history,
        systemInstruction: {
            parts: [{ text: systemInstructions }]
        },
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 400,
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
                            // Si la IA responde con "CITA_COMPLETADA", llamamos a la función de agendamiento.
                            if (part.text.includes("CITA_COMPLETADA")) {
                                console.log("Se ha recibido la señal para agendar la cita.");
                                const appointmentDetails = extractAppointmentDetails(history);
                                // Llama a la función que gestiona la cita
                                await handleAppointmentFlow(appointmentDetails);
                                // Devuelve un mensaje de confirmación al usuario.
                                return "¡Excelente! Tu cita ha sido agendada con éxito. Te esperamos.";
                            }
                            console.log("Respuesta de Gemini recibida exitosamente.");
                            return part.text;
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

// Función para extraer los datos relevantes del historial de conversación.
function extractAppointmentDetails(history) {
    const details = {
        nombre: null,
        telefono: null,
        fecha: null,
        hora: null
    };

    // Recorre el historial en busca de la información necesaria.
    history.forEach(message => {
        const text = message.parts[0].text;
        // Aquí se usaría una lógica más robusta para parsear los datos
        // Por ahora, es un placeholder.
        if (text.toLowerCase().includes("griger ratia")) {
            details.nombre = "Griger Ratia";
        }
        if (text.includes("04247654321")) {
            details.telefono = "04247654321";
        }
        if (text.toLowerCase().includes("jueves de la semana que viene")) {
            details.fecha = "Jueves de la próxima semana";
        }
        if (text.includes("10:00")) {
            details.hora = "10:00 AM";
        }
    });

    return details;
}

// Función principal que orquesta la creación de la cita.
async function handleAppointmentFlow(appointmentDetails) {
    try {
        console.log("Detalles de la cita a procesar:", appointmentDetails);

        // TODO: En esta sección, agregaremos las llamadas a Airtable y Calendly.

        // Ejemplo de llamada a Calendly (futuro)
        // const calendlyResponse = await createCalendlyEvent(appointmentDetails);
        // if (calendlyResponse) {
        //     console.log("Evento de Calendly creado con éxito.");
        // }

        // Ejemplo de llamada a Airtable (futuro)
        // const airtableResponse = await createAirtableRecord(appointmentDetails);
        // if (airtableResponse) {
        //     console.log("Registro en Airtable creado con éxito.");
        // }

    } catch (error) {
        console.error("Error en el flujo de agendamiento:", error);
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
