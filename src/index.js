// Importa las librerías necesarias.
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

// Se importa la librería de Airtable.
const Airtable = require('airtable');

// Configura la aplicación Express.
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.urlencoded({ extended: false }));

// Variable para almacenar el historial de la conversación.
const conversationHistory = {};

// Configura Airtable con las variables de entorno.
const airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// Configura las credenciales de Calendly
const CALENDLY_API_URL = 'https://api.calendly.com';
const CALENDLY_ACCESS_TOKEN = process.env.CALENDLY_PERSONAL_ACCESS_TOKEN;
const CALENDLY_EVENT_TYPE_URI = process.env.CALENDLY_EVENT_TYPE_URI;
// Agrega la nueva variable de entorno para el URI del usuario
const CALENDLY_USER_URI = process.env.CALENDLY_USER_URI;

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

    const systemInstructions = "Eres un asistente de citas para un consultorio oftalmológico. Tu única función es agendar citas. Debes ser capaz de interpretar fechas y horas a partir de expresiones como 'mañana', 'el lunes de la semana que viene', 'pasado mañana' o 'el jueves siguiente', y convertirlas a un formato de fecha completo. No respondas a preguntas médicas, de facturación o de otro tipo que no sean agendar. Cuando tengas el nombre completo, número de teléfono, fecha y hora del cliente, debes devolver un objeto JSON con los siguientes campos: 'nombre', 'telefono', 'fecha' y 'hora'. La fecha debe estar en formato 'YYYY-MM-DD'. No incluyas ningún otro texto o puntuación antes o después del JSON.";

    const payload = {
        contents: history,
        systemInstruction: {
            parts: [{ text: systemInstructions }]
        },
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 400,
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    nombre: { "type": "STRING" },
                    telefono: { "type": "STRING" },
                    fecha: { "type": "STRING" },
                    hora: { "type": "STRING" },
                },
                required: ["nombre", "telefono", "fecha", "hora"]
            }
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

// --- Funciones para la Gestión de la Cita ---
async function handleAppointmentFlow(appointmentDetails) {
    try {
        console.log("Detalles de la cita a procesar:", appointmentDetails);

        // 1. Crear el registro en Airtable
        const airtableResponse = await createAirtableRecord(appointmentDetails);
        if (airtableResponse) {
            console.log("Registro en Airtable creado con éxito.");
        }

        // 2. Crear el evento en Calendly
        await createCalendlyEvent(appointmentDetails);
        console.log("Evento en Calendly creado con éxito.");

    } catch (error) {
        console.error("Error en el flujo de agendamiento:", error);
        throw error;
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

// Función para crear un evento en Calendly.
async function createCalendlyEvent(details) {
    if (!CALENDLY_ACCESS_TOKEN || !CALENDLY_EVENT_TYPE_URI || !CALENDLY_USER_URI) {
        throw new Error("Tokens de Calendly o URI de usuario no configurados en .env");
    }

    // Convierte la fecha y hora a un formato ISO 8601 con zona horaria.
    const start_time = `${details.fecha}T${details.hora}:00Z`;
    const end_time = new Date(new Date(start_time).getTime() + 30 * 60000).toISOString(); // 30 minutos de duración

    // Separar el nombre completo en nombre y apellido(s)
    const nameParts = details.nombre.trim().split(/\s+/);
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ');

    const payload = {
        // Se agrega el URI del usuario, que es obligatorio para la API de Calendly
        user: CALENDLY_USER_URI, 
        event_type: CALENDLY_EVENT_TYPE_URI,
        invitees: [
            {
                email: 'cliente@example.com', // Usar un email de contacto o solicitarlo
                first_name: firstName,
                last_name: lastName,
                phone_number: details.telefono
            }
        ],
        start_time: start_time,
        end_time: end_time,
        location: 'El consultorio', // Puedes personalizar este valor
    };

    try {
        const response = await axios.post(`${CALENDLY_API_URL}/scheduled_events`, payload, {
            headers: {
                'Authorization': `Bearer ${CALENDLY_ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
                // Agregamos la cabecera necesaria para la función beta
                'Calendly-Beta-Features': 'scheduled_events'
            }
        });
        return response.data;
    } catch (error) {
        console.error("Error creando evento en Calendly:", error.response?.data || error.message);
        throw error;
    }
}

// --- Función para obtener las URIs de Calendly ---
async function fetchCalendlyURIs() {
    if (!CALENDLY_ACCESS_TOKEN) {
        console.error("CALENDLY_ACCESS_TOKEN no está configurado en el archivo .env.");
        return;
    }

    try {
        // Obtener el URI del usuario
        const userResponse = await axios.get(`${CALENDLY_API_URL}/users/me`, {
            headers: {
                'Authorization': `Bearer ${CALENDLY_ACCESS_TOKEN}`
            }
        });
        const userUri = userResponse.data.resource.uri;
        console.log("¡Éxito! Tu URI de usuario de Calendly es:", userUri);
        
        // Obtener el URI del tipo de evento
        const eventTypesResponse = await axios.get(`${CALENDLY_API_URL}/event_types?user=${userUri}`, {
            headers: {
                'Authorization': `Bearer ${CALENDLY_ACCESS_TOKEN}`
            }
        });
        const eventTypeUri = eventTypesResponse.data.collection[0].uri;
        console.log("¡Éxito! El URI de tu primer tipo de evento es:", eventTypeUri);
        
        console.log("\n--- PASO SIGUIENTE ---");
        console.log("1. Copia las URIs anteriores.");
        console.log("2. Pégalas en tu archivo .env con las variables 'CALENDLY_USER_URI' y 'CALENDLY_EVENT_TYPE_URI'.");
        console.log("3. Descomenta la llamada a la función 'handleAppointmentFlow' en la línea ~98 para habilitar el agendamiento de citas.");

    } catch (error) {
        console.error("Error al obtener las URIs de Calendly. Asegúrate de que el token es correcto y tiene los permisos 'user:read' y 'event_types:read'.");
        console.error("Detalles del error:", error.response?.data || error.message);
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

    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(twilioApiUrl, payload, {
                auth: {
                    username: TWILIO_ACCOUNT_SID,
                    password: TWILIO_AUTH_TOKEN
                }
            });
            // Si tiene éxito, sal del bucle
            return;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.error(`Error 429: Demasiadas solicitudes a Twilio. Reintento ${i + 1} de ${maxRetries}...`);
                const delay = Math.pow(2, i) * 1000; // Aumenta el tiempo de espera
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                } else {
                    console.error("Máximo de reintentos alcanzado para Twilio. Fallando. Se ignorará el error para no detener el flujo de la aplicación.");
                    return; // No se relanza el error para evitar detener la app completa
                }
            } else {
                console.error(`Error enviando mensaje con Twilio: ${error.message}`);
                throw error;
            }
        }
    }
}

// Inicia el servidor de Express en el puerto configurado.
app.listen(port, () => {
    console.log(`Servidor escuchando en http://localhost:${port}`);
    // Llama a la nueva función para obtener las URIs de Calendly
    fetchCalendlyURIs();
});
