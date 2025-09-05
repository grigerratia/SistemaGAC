// Importa las librerías necesarias.
// express: Es un framework para crear el servidor web.
// body-parser: Un middleware para procesar datos de solicitudes HTTP.
// axios: Una librería para hacer solicitudes a APIs externas (como Twilio y Gemini).
// path: Módulo de Node.js para manejar rutas de archivos.
// dotenv: Permite cargar variables de entorno desde un archivo .env.
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

// Configura la aplicación Express.
const app = express();
// Define el puerto. Render lo asigna automáticamente a través de una variable de entorno.
const port = process.env.PORT || 3000;

// Usa body-parser para procesar las solicitudes entrantes de Twilio.
// extended: false significa que usa la librería 'qs' para el parsing, que es la recomendada.
app.use(bodyParser.urlencoded({ extended: false }));

// --- EL ENDPOINT PRINCIPAL PARA TWILIO ---
// Esta es la ruta que Twilio intentará contactar cuando reciba un mensaje de WhatsApp.
// Es crucial que esta ruta (/whatsapp-webhook) coincida con la URL de webhook en la configuración de Twilio.
app.post('/whatsapp-webhook', (req, res) => {
    // IMPORTANTE: Se envía una respuesta inmediata a Twilio.
    // Esto es para evitar los errores de timeout (502 Bad Gateway) que vimos.
    // Twilio espera una respuesta rápida para saber que el servidor está vivo.
    res.send('OK');

    // Se llama a una función asíncrona para procesar el mensaje en segundo plano.
    // De esta manera, el servidor responde rápido a Twilio y luego se toma el tiempo que necesite para la lógica de la IA.
    processMessage(req.body);
});

// --- Función que procesa el mensaje en segundo plano ---
// Esta función contiene toda la lógica del asistente.
async function processMessage(body) {
    try {
        // Extrae el mensaje y los números de teléfono del cuerpo de la solicitud de Twilio.
        const userMessage = body.Body;
        const fromNumber = body.From;
        const toNumber = body.To;

        // Si el mensaje está vacío, ignora la solicitud.
        if (!userMessage) {
            console.log("Mensaje vacío recibido, ignorando.");
            return;
        }

        // Llama a la función que se comunica con la API de Gemini para obtener una respuesta.
        const geminiResponse = await generateGeminiResponse(userMessage);

        // Si la IA generó una respuesta, la envía de vuelta al usuario a través de Twilio.
        if (geminiResponse) {
            await sendTwilioResponse(fromNumber, toNumber, geminiResponse);
        }

    } catch (error) {
        // En caso de que algo falle en el proceso (por ejemplo, la API de Gemini no responde).
        console.error(`Error procesando mensaje: ${error.message}`);
        // Envía un mensaje de error al usuario para que sepa que algo salió mal.
        await sendTwilioResponse(body.From, body.To, "Lo siento, hubo un problema procesando tu solicitud.");
    }
}

// --- Función para llamar a la API de Gemini ---
// Se encarga de construir la solicitud y enviar el mensaje del usuario a la IA.
async function generateGeminiResponse(userMessage) {
    // Obtiene la clave de la API de las variables de entorno.
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent";

    // Las instrucciones del sistema le dicen a la IA cómo debe comportarse.
    const systemInstructions = "Eres un asistente de citas para un consultorio oftalmológico. Mantén un tono profesional, amable y conciso. Tu única función es agendar citas. No respondas a preguntas médicas, de facturación o de otro tipo que no sean agendar. En esos casos, pide amablemente que el cliente se comunique directamente con el consultorio.";

    // El 'payload' es el objeto JSON que se envía a la API de Gemini.
    const payload = {
        contents: [
            { parts: [{ text: userMessage }] }
        ],
        systemInstruction: {
            parts: [{ text: systemInstructions }]
        },
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 200,
        },
    };

    const url = `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`;
    
    try {
        // Envía la solicitud POST a la API de Gemini.
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        // Procesa la respuesta de la API de Gemini y extrae el texto generado.
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
        // Manejo de errores si la llamada a Gemini falla.
        console.error(`Error llamando a la API de Gemini: ${error.message}`);
        throw error;
    }
    return null;
}

// --- Función para enviar un mensaje usando la API de Twilio ---
// Se encarga de enviar el mensaje de respuesta de la IA de vuelta al usuario.
async function sendTwilioResponse(to, from, body) {
    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;

    const twilioApiUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

    // El 'payload' para Twilio debe ser de tipo URLSearchParams.
    const payload = new URLSearchParams();
    payload.append('From', from); // El número de Twilio que envía el mensaje.
    payload.append('To', to);     // El número del usuario que lo recibe.
    payload.append('Body', body); // El cuerpo del mensaje.

    try {
        // Envía la solicitud POST a la API de Twilio. Se necesita autenticación con el SID y el token.
        const response = await axios.post(twilioApiUrl, payload, {
            auth: {
                username: TWILIO_ACCOUNT_SID,
                password: TWILIO_AUTH_TOKEN
            }
        });
    } catch (error) {
        // Manejo de errores si el envío del mensaje falla.
        console.error(`Error enviando mensaje con Twilio: ${error.message}`);
        throw error;
    }
}

// Inicia el servidor de Express en el puerto configurado.
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
});
