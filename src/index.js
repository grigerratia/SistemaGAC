// // Importa las librerías necesarias.
// const express = require('express');
// const bodyParser = require('body-parser');
// const axios = require('axios');
// const moment = require('moment');
// const cron = require('node-cron');
// require('dotenv').config();

// // Se importa la librería de Airtable.
// const Airtable = require('airtable');

// // Configura la aplicación Express.
// const app = express();
// const port = process.env.PORT || 3000;

// app.use(bodyParser.urlencoded({ extended: false }));

// // Variable para almacenar el historial de la conversación.
// const conversationHistory = {};

// // Configura Airtable con las variables de entorno.
// const airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// // --- EL ENDPOINT PRINCIPAL PARA TWILIO ---
// app.post('/whatsapp-webhook', (req, res) => {
//     // Envía una respuesta TwiML vacía de inmediato para evitar que Twilio reintente.
//     // Esto es el formato XML correcto que Twilio espera.
//     res.writeHead(200, { 'Content-Type': 'text/xml' });
//     res.end('<Response/>');

//     // Procesa el mensaje de forma asíncrona para no bloquear la respuesta.
//     setImmediate(() => processMessage(req.body));
// });

// // --- Función que procesa el mensaje en segundo plano ---
// async function processMessage(body) {
//     try {
//         const fromNumber = body.From;
//         const toNumber = body.To;
//         let userMessage = body.Body;

//         if (!userMessage) {
//             console.log("Mensaje vacío recibido, ignorando.");
//             return;
//         }

//         // 1. Procesa la fecha relativa antes de pasársela a Gemini.
//         userMessage = parseRelativeDate(userMessage);

//         if (!conversationHistory[fromNumber]) {
//             conversationHistory[fromNumber] = [];
//         }

//         conversationHistory[fromNumber].push({
//             role: "user",
//             parts: [{ text: userMessage }]
//         });

//         const geminiResponse = await generateGeminiResponse(conversationHistory[fromNumber]);

//         if (geminiResponse) {
//             conversationHistory[fromNumber].push({
//                 role: "model",
//                 parts: [{ text: geminiResponse }]
//             });
//             await sendTwilioResponse(fromNumber, toNumber, geminiResponse);
//         }

//     } catch (error) {
//                 console.error(`Error procesando mensaje: ${error.message}`);
//         await sendTwilioResponse(body.From, body.To, "Lo siento, hubo un problema procesando tu solicitud.");
//     }
// }

// // --- Función para traducir fechas relativas a un formato concreto ---
// function parseRelativeDate(message) {
//     const today = moment();
//     let dateToParse = null;

//     const tomorrowRegex = /(mañana|manana|pasado mañana|pasado manana)/i;
//     const dayOfWeekRegex = /(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i;
//     const nextWeekRegex = /(semana que viene|próxima semana|proxima semana)/i;

//     // Convertir el mensaje a minúsculas y normalizar para buscar días sin tildes
//     const normalizedMessage = message.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

//     if (tomorrowRegex.test(normalizedMessage)) {
//         dateToParse = moment().add(1, 'day');
//     } else {
//         const dayMatch = dayOfWeekRegex.exec(normalizedMessage);
//         if (dayMatch) {
//             const dayOfWeek = dayMatch[1];
            
//             // Encuentra el día de la semana correcto
//             const daysMap = {
//                 "lunes": 1, "martes": 2, "miercoles": 3, "jueves": 4, "viernes": 5, "sabado": 6, "domingo": 0,
//                 "miércoles": 3, "sábado": 6
//             };
//             let targetDay = daysMap[dayOfWeek];
            
//             // Crea una fecha para el día de la semana solicitado
//             dateToParse = moment().day(targetDay);

//             // Si el día ya pasó esta semana y no se menciona "semana que viene",
//             // lo movemos a la siguiente semana
//             if (dateToParse.isBefore(today, 'day') || nextWeekRegex.test(normalizedMessage)) {
//                 dateToParse.add(7, 'days');
//             }
//         }
//     }

//     if (dateToParse) {
//         const formattedDate = dateToParse.format('YYYY-MM-DD');
//         console.log(`Fecha relativa parseada: ${message} -> ${formattedDate}`);
//         // Reemplaza la fecha relativa en el mensaje con la fecha formateada.
//         return message.replace(tomorrowRegex, formattedDate).replace(dayOfWeekRegex, formattedDate).replace(nextWeekRegex, '');
//     }

//     return message;
// }


// // --- Función principal para llamar a la API de Gemini ---
// async function generateGeminiResponse(history) {
//     const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
//     const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent";

//     const systemInstructions = `Eres un asistente de citas para el consultorio del Doctor Lucas. Tu única función es agendar citas.
    
//     Reglas de agendamiento:
//     - Consultas en el consultorio: Lunes a viernes, de 8 AM a 11 AM. Costo: $25.
//     - Consultas a domicilio: Lunes a viernes, de 3 PM a 7 PM. Costo: $30.
    
//     Si el cliente menciona que quiere pagar por adelantado, pídele el código de referencia de la transferencia o pago móvil.
    
//     Para agendar una cita, necesitas el nombre completo, número de teléfono, fecha, y hora.
    
//     **ATENCIÓN**: Solo debes responder con un objeto JSON si la conversación te ha proporcionado **todos** los siguientes datos: 'nombre', 'telefono', 'fecha' y 'hora'. La fecha debe estar en formato YYYY-MM-DD. Si falta alguno de estos datos, **NO** generes el JSON y continúa la conversación de forma natural para solicitarlos. No incluyas ningún otro texto o puntuación antes o después del JSON.
    
//     Si el cliente envía una referencia de pago en un mensaje posterior a haber agendado su cita, debes responder preguntando nuevamente su nombre para buscar el registro y confirmarlo. Luego, cuando el cliente envíe su nombre junto a la referencia de pago, debes devolver un objeto JSON con los campos 'nombre', 'telefono' y 'referenciaPago', dejando los demás campos vacíos. Esto servirá para actualizar el registro del cliente en la base de datos.
    
//     No respondas a preguntas médicas, de facturación o de otro tipo que no sean agendar.`;

//     const payload = {
//         contents: history,
//         systemInstruction: {
//             parts: [{ text: systemInstructions }]
//         },
//         generationConfig: {
//             temperature: 0.7,
//             maxOutputTokens: 400,
//             responseMimeType: "text/plain"
//         }
//     };

//     const url = `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`;

//     const maxRetries = 10;
//     for (let i = 0; i < maxRetries; i++) {
//         try {
//             const response = await axios.post(url, payload, {
//                 headers: { 'Content-Type': 'application/json' }
//             });

//             const responseData = response.data;
//             if (responseData?.candidates?.length > 0) {
//                 const firstCandidate = responseData.candidates[0];
//                 if (firstCandidate.content?.parts?.length > 0) {
//                     for (const part of firstCandidate.content.parts) {
//                         if (part.text) {
//                             // Verifica si la respuesta de Gemini es un JSON válido
//                             if (part.text.trim().startsWith('{') && part.text.trim().endsWith('}')) {
//                                 try {
//                                     const appointmentDetails = JSON.parse(part.text);
//                                     console.log("JSON de Gemini recibido:", appointmentDetails);
//                                     await handleAppointmentFlow(appointmentDetails);
//                                     return "¡Excelente! Tu cita ha sido agendada con éxito. Te esperamos.";
//                                 } catch (e) {
//                                     console.log("Error al parsear el JSON de Gemini. Devolviendo texto conversacional.");
//                                     return "Lo siento, tuve un problema con la información que me enviaste. ¿Podrías confirmarme todos los datos de nuevo por favor?";
//                                 }
//                             } else {
//                                 console.log("Respuesta de Gemini recibida, en modo conversacional.");
//                                 return part.text;
//                             }
//                         }
//                     }
//                 }
//             }
//         } catch (error) {
//             if (error.response?.status === 429) {
//                 console.error(`Error 429: Demasiadas solicitudes. Reintento ${i + 1} de ${maxRetries}...`);
//                 const delay = Math.pow(2, i) * 10000;
//                 if (i < maxRetries - 1) {
//                     await new Promise(resolve => setTimeout(resolve, delay));
//                     continue;
//                 } else {
//                     console.error("Máximo de reintentos alcanzado. Fallando.");
//                     throw error;
//                 }
//             } else {
//                 console.error(`Error llamando a la API de Gemini: ${error.message}`);
//                 throw error;
//             }
//         }
//     }

//     return null;
// }

// // --- Función que formatea los datos para Airtable ---
// function formatAppointmentForAirtable(appointmentDetails) {
//     const airtableRecord = {
//         "Nombre": appointmentDetails.nombre,
//         "Teléfono": appointmentDetails.telefono,
//         // Combina fecha y hora en el formato correcto para Airtable
//         "Fecha": `${appointmentDetails.fecha}T${appointmentDetails.hora}:00`,
//         "Referencia": appointmentDetails.referenciaPago || ""
//     };
//     return airtableRecord;
// }

// // --- Funciones para la Gestión de la Cita ---
// async function handleAppointmentFlow(appointmentDetails) {
//     try {
//         console.log("Detalles de la cita a procesar:", appointmentDetails);

//         // Si la referencia de pago está presente, es una actualización
//         if (appointmentDetails.referenciaPago && appointmentDetails.nombre) {
//             const record = await findRecordByName(appointmentDetails.nombre);
//             if (record) {
//                 console.log("Actualizando referencia de pago en Airtable...");
//                 await updateAirtableRecord(record.id, { "Referencia": appointmentDetails.referenciaPago });
//                 console.log("Campo de Referencia en Airtable actualizado con éxito.");
//             } else {
//                 console.log("No se encontró un registro con ese nombre para actualizar.");
//             }
//         } else if (appointmentDetails.nombre && appointmentDetails.telefono && appointmentDetails.fecha && appointmentDetails.hora) {
//             // Si tiene todos los datos, es una nueva cita o una actualización completa
//             const existingRecord = await findRecordByPhoneNumber(appointmentDetails.telefono);

//             if (existingRecord) {
//                 console.log("Ya existe un registro. Actualizando cita...");
//                 const airtableRecord = formatAppointmentForAirtable(appointmentDetails);
//                 console.log("Objeto para Airtable:", airtableRecord);
//                 await updateAirtableRecord(existingRecord.id, airtableRecord);
//                 console.log("Registro en Airtable actualizado con éxito.");
//             } else {
//                 console.log("No existe un registro. Creando nueva cita...");
//                 const airtableRecord = formatAppointmentForAirtable(appointmentDetails);
//                 console.log("Objeto para Airtable:", airtableRecord);
//                 await createAirtableRecord(airtableRecord);
//                 console.log("Nuevo registro en Airtable creado con éxito.");
//             }
//         } else {
//             console.log("Datos de cita incompletos o en un formato inesperado.");
//         }
        
//     } catch (error) {
//         console.error("Error en el flujo de agendamiento:", error.message);
//         throw error;
//     }
// }

// // Función para encontrar un registro por número de teléfono
// async function findRecordByPhoneNumber(phoneNumber) {
//     try {
//         const table = airtableBase('Citas');
//         const records = await table.select({
//             view: "Grid view",
//             filterByFormula: `{Teléfono} = '${phoneNumber}'`
//         }).firstPage();
//         return records[0] || null;
//     } catch (error) {
//         console.error("Error buscando registro en Airtable por teléfono:", error.message);
//         throw error;
//     }
// }

// // Función para encontrar un registro por nombre
// async function findRecordByName(name) {
//     try {
//         const table = airtableBase('Citas');
//         const records = await table.select({
//             view: "Grid view",
//             filterByFormula: `{Nombre} = '${name}'`
//         }).firstPage();
//         return records[0] || null;
//     } catch (error) {
//         console.error("Error buscando registro en Airtable por nombre:", error.message);
//         throw error;
//     }
// }

// // Función para crear un nuevo registro en Airtable.
// async function createAirtableRecord(details) {
//     try {
//         const table = airtableBase('Citas');
//         const createdRecord = await table.create(details);
//         return createdRecord;
//     } catch (error) {
//         console.error("Error creando registro en Airtable:", error.message);
//         throw error;
//     }
// }

// // Función para actualizar un registro existente en Airtable.
// async function updateAirtableRecord(recordId, details) {
//     try {
//         const table = airtableBase('Citas');
//         const updatedRecord = await table.update(recordId, details);
//         return updatedRecord;
//     } catch (error) {
//         console.error("Error actualizando registro en Airtable:", error.message);
//         throw error;
//     }
// }

// // --- Programación de recordatorios (se mantiene) ---
// cron.schedule('0 9 * * *', async () => {
//     console.log('Verificando citas para enviar recordatorios...');
//     const tomorrow = moment().add(1, 'day').format('YYYY-MM-DD');
    
//     try {
//         const records = await airtableBase('Citas').select({
//             view: "Grid view",
//             filterByFormula: `DATETIME_FORMAT({Fecha}, 'YYYY-MM-DD') = '${tomorrow}'`
//         }).all();
        
//         for (const record of records) {
//             const phoneNumber = record.fields.Teléfono;
//             const appointmentDate = moment(record.fields.Fecha).format('LL');
//             const appointmentTime = moment(record.fields.Fecha).format('h:mm A');
//             const message = `Recordatorio: Tienes una cita con el Doctor Lucas mañana, ${appointmentDate} a las ${appointmentTime}. ¡Te esperamos!`;
            
//             await sendTwilioResponse(phoneNumber, process.env.TWILIO_PHONE_NUMBER, message);
//             console.log(`Recordatorio enviado a ${phoneNumber}`);
//         }
        
//     } catch (error) {
//         console.error("Error al enviar recordatorios:", error);
//     }
// });

// // --- Función para enviar un mensaje usando la API de Twilio (se mantiene) ---
// async function sendTwilioResponse(to, from, body) {
//     const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
//     const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
//     const twilioApiUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

//     const payload = new URLSearchParams();
//     payload.append('From', from);
//     payload.append('To', to);
//     payload.append('Body', body);

//     const maxRetries = 10;
//     for (let i = 0; i < maxRetries; i++) {
//         try {
//             await axios.post(twilioApiUrl, payload, {
//                 auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN }
//             });
//             return;
//         } catch (error) {
//             if (error.response?.status === 429) {
//                 console.error(`Error 429: Demasiadas solicitudes a Twilio. Reintento ${i + 1} de ${maxRetries}...`);
//                 const delay = Math.pow(2, i) * 1000;
//                 if (i < maxRetries - 1) {
//                     await new Promise(resolve => setTimeout(resolve, delay));
//                     continue;
//                 } else {
//                     console.error("Máximo de reintentos alcanzado para Twilio. Fallando.");
//                     return;
//                 }
//             } else {
//                 console.error(`Error enviando mensaje con Twilio: ${error.message}`);
//                 throw error;
//             }
//         }
//     }
// }

// // Inicia el servidor de Express en el puerto configurado.
// app.listen(port, () => {
//     console.log(`Servidor escuchando en http://localhost:${port}`);
// });

// Importa las librerías necesarias.
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

// --- Nuevas Funciones para la Gestión de la Cita ---
async function handleAppointmentFlow(appointmentDetails) {
    try {
        console.log("Detalles de la cita a procesar:", appointmentDetails);

        const airtableResponse = await createAirtableRecord(appointmentDetails);
        if (airtableResponse) {
            console.log("Registro en Airtable creado con éxito.");
        }

        const calendlyResponse = await createCalendlyEvent(appointmentDetails);
        if (calendlyResponse) {
            console.log("Evento de Calendly creado con éxito.");
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

// Función para crear un nuevo evento en Calendly usando axios.
async function createCalendlyEvent(details) {
    const CALENDLY_API_URL = "https://api.calendly.com";
    const CALENDLY_TOKEN = process.env.CALENDLY_PERSONAL_ACCESS_TOKEN;
    const CALENDLY_EVENT_TYPE_URI = process.env.CALENDLY_EVENT_TYPE_URI;

    try {
        const inviteeEmail = "ejemplo@ejemplo.com";
        const inviteeName = details.nombre;
        const startTime = `${details.fecha}T${details.hora}:00Z`;

        const payload = {
            invitee_email: inviteeEmail,
            event_type: CALENDLY_EVENT_TYPE_URI,
            invitee: {
                name: inviteeName,
                email: inviteeEmail,
            },
            start_time: startTime
        };

        const response = await axios.post(`${CALENDLY_API_URL}/scheduled_events`, payload, {
            headers: {
                'Authorization': `Bearer ${CALENDLY_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        console.error("Error creando evento en Calendly:", error.response ? error.response.data : error.message);
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