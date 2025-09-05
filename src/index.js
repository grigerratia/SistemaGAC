// Importa las librerías necesarias
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

// Configura la aplicación Express
const app = express();
// El puerto es asignado por el entorno de Render
const port = process.env.PORT || 3000;

// Usa body-parser para procesar las solicitudes de Twilio
app.use(bodyParser.urlencoded({ extended: false }));

// --- EL ENDPOINT PRINCIPAL PARA TWILIO ---
// Esta ruta DEBE coincidir con la URL de webhook en la configuración de Twilio.
// No cambies esta ruta, ya que está configurada para el endpoint `/whatsapp-webhook`.
app.post('/whatsapp-webhook', async (req, res) => {
    try {
        // 1. Obtén el mensaje del cuerpo de la solicitud de Twilio
        const userMessage = req.body.Body;
        const fromNumber = req.body.From;
        const toNumber = req.body.To;

        if (!userMessage) {
            return res.send('OK');
        }

        // 2. Llama a la API de Gemini para obtener una respuesta
        const geminiResponse = await generateGeminiResponse(userMessage);

        if (geminiResponse) {
            // 3. Envía la respuesta de la IA de vuelta al usuario
            await sendTwilioResponse(fromNumber, toNumber, geminiResponse);
        }

        res.send('OK');

    } catch (error) {
        console.error(`Error procesando mensaje: ${error.message}`);
        // Envía un mensaje de error al usuario en caso de falla
        await sendTwilioResponse(req.body.From, req.body.To, "Lo siento, hubo un problema procesando tu solicitud.");
        res.status(500).send('Error');
    }
});

// --- Función para llamar a la API de Gemini ---
async function generateGeminiResponse(userMessage) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";

    // Estas son las instrucciones que guían el comportamiento de la IA
    const systemInstructions = "Eres un asistente de citas para un consultorio oftalmológico. Mantén un tono profesional, amable y conciso. Tu única función es agendar citas. No respondas a preguntas médicas, de facturación o de otro tipo que no sean agendar. En esos casos, pide amablemente que el cliente se comunique directamente con el consultorio.";

    const prompt = `
    Actúa como el asistente del consultorio. Basado en el siguiente mensaje del cliente, decide si su intención es agendar una cita o no.

    Instrucciones para agendar:
    - Ofrece las citas en el consultorio de lunes a viernes de 8:00 AM a 11:00 AM.
    - Ofrece las citas a domicilio de lunes a viernes de 3:00 PM a 7:00 PM.
    - El costo de la consulta es de 25 dólares.
    - Di que le enviarás un enlace para que pueda agendar.

    Instrucciones para otros casos:
    - Si el mensaje no es sobre agendar, responde amablemente que tu función es solo agendar citas y pide que se comunique al consultorio para otras consultas.

    Mensaje del cliente:
    ${userMessage}
    `;

    const payload = {
        contents: [
            {
                parts: [
                    { text: userMessage }
                ]
            }
        ],
        systemInstruction: {
            parts: [
                { text: systemInstructions }
            ]
        },
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 200,
        },
    };

    const url = `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`;
    
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // Extrae el texto generado de forma segura
        const responseData = response.data;
        if (responseData && responseData.candidates && responseData.candidates.length > 0) {
            const firstCandidate = responseData.candidates[0];
            if (firstCandidate.content && firstCandidate.content.parts) {
                for (const part of firstCandidate.content.parts) {
                    if (part.text) {
                        return part.text;
                    }
                }
            }
        }
    } catch (error) {
        console.error(`Error llamando a la API de Gemini: ${error.message}`);
        throw error;
    }
    return null;
}

// --- Función para enviar un mensaje usando la API de Twilio ---
async function sendTwilioResponse(to, from, body) {
    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

    const twilioApiUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

    const payload = new URLSearchParams();
    payload.append('From', from); // El número que envía el mensaje (tu número de Twilio)
    payload.append('To', to);     // El número que recibe el mensaje (el número del usuario)
    payload.append('Body', body);

    try {
        await axios.post(twilioApiUrl, payload, {
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

// Inicia el servidor
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});