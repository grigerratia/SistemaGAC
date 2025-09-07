// Importa las librerías necesarias.
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const moment = require('moment');
const cron = require('node-cron');
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

// --- EL ENDPOINT PRINCIPAL PARA TWILIO ---
app.post('/whatsapp-webhook', (req, res) => {
    res.send('OK');
    processMessage(req.body);
});

// --- Función que procesa el mensaje en segundo plano ---
async function processMessage(body) {
    try {
        const fromNumber = body.From;
        const toNumber = body.To;
        let userMessage = body.Body;

        if (!userMessage) {
            console.log("Mensaje vacío recibido, ignorando.");
            return;
        }

        // 1. Procesa la fecha relativa antes de pasársela a Gemini.
        userMessage = parseRelativeDate(userMessage);

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

// --- Función para traducir fechas relativas a un formato concreto ---
function parseRelativeDate(message) {
    const today = moment();
    const tomorrow = moment().add(1, 'day');

    const dayOfWeekRegex = /(lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)/i;
    const tomorrowRegex = /(mañana|manana|pasado mañana|pasado manana)/i;
    const nextWeekRegex = /semana que viene|próxima semana|proxima semana/i;

    let parsedDate = null;
    let originalDay = null;

    if (tomorrowRegex.test(message)) {
        parsedDate = tomorrow.format('YYYY-MM-DD');
    } else {
        const dayMatch = message.match(dayOfWeekRegex);
        if (dayMatch) {
            originalDay = dayMatch[1].toLowerCase();
            const daysInSpanish = ["domingo", "lunes", "martes", "miércoles", "miercoles", "jueves", "viernes", "sábado", "sabado"];
            let dayIndex = daysInSpanish.indexOf(originalDay);

            if (dayIndex === -1) {
                // Manejar tildes y sin tildes
                const normalizedDay = originalDay.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
                dayIndex = daysInSpanish.indexOf(normalizedDay);
            }

            const currentDayIndex = today.day();
            let daysToAdd = dayIndex - currentDayIndex;

            if (daysToAdd <= 0 || nextWeekRegex.test(message)) {
                daysToAdd += 7;
            }

            parsedDate = today.add(daysToAdd, 'days').format('YYYY-MM-DD');
        }
    }

    if (parsedDate) {
        // Reemplaza la fecha relativa en el mensaje con la fecha formateada.
        let newMessage = message;
        if (originalDay) {
            newMessage = newMessage.replace(new RegExp(originalDay, 'i'), parsedDate);
        } else {
            newMessage = newMessage.replace(tomorrowRegex, parsedDate);
        }
        return newMessage;
    }

    return message;
}


// --- Función principal para llamar a la API de Gemini ---
async function generateGeminiResponse(history) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent";

    const systemInstructions = `Eres un asistente de citas para el consultorio del Doctor Lucas. Tu única función es agendar citas.
    
    Reglas de agendamiento:
    - Consultas en el consultorio: Lunes a viernes, de 8 AM a 11 AM. Costo: $25.
    - Consultas a domicilio: Lunes a viernes, de 3 PM a 7 PM. Costo: $30.
    
    Si el cliente menciona que quiere pagar por adelantado, pídele el código de referencia de la transferencia o pago móvil.
    
    Para agendar una cita, necesitas el nombre completo, número de teléfono, fecha, y hora.
    
    **ATENCIÓN**: Solo debes responder con un objeto JSON si la conversación te ha proporcionado **todos** los siguientes datos: 'nombre', 'telefono', 'fecha' y 'hora'. La fecha debe estar en formato YYYY-MM-DD. Si falta alguno de estos datos, **NO** generes el JSON y continúa la conversación de forma natural para solicitarlos. No incluyas ningún otro texto o puntuación antes o después del JSON.
    
    Si el cliente envía una referencia de pago en un mensaje posterior a haber agendado su cita, debes responder preguntando nuevamente su nombre para buscar el registro y confirmarlo. Luego, cuando el cliente envíe su nombre junto a la referencia de pago, debes devolver un objeto JSON con los campos 'nombre', 'telefono' y 'referenciaPago', dejando los demás campos vacíos. Esto servirá para actualizar el registro del cliente en la base de datos.
    
    No respondas a preguntas médicas, de facturación o de otro tipo que no sean agendar.`;

    const payload = {
        contents: history,
        systemInstruction: {
            parts: [{ text: systemInstructions }]
        },
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 400,
            responseMimeType: "text/plain"
        }
    };

    const url = `${GEMINI_API_URL}?key=${GEMINI_API_KEY}`;

    const maxRetries = 10;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await axios.post(url, payload, {
                headers: { 'Content-Type': 'application/json' }
            });

            const responseData = response.data;
            if (responseData?.candidates?.length > 0) {
                const firstCandidate = responseData.candidates[0];
                if (firstCandidate.content?.parts?.length > 0) {
                    for (const part of firstCandidate.content.parts) {
                        if (part.text) {
                            try {
                                const appointmentDetails = JSON.parse(part.text);
                                console.log("JSON de Gemini recibido:", appointmentDetails);
                                await handleAppointmentFlow(appointmentDetails);
                                return "¡Excelente! Tu cita ha sido agendada con éxito. Te esperamos.";
                            } catch (e) {
                                console.log("Respuesta de Gemini recibida, en modo conversacional.");
                                return part.text;
                            }
                        }
                    }
                }
            }
        } catch (error) {
            if (error.response?.status === 429) {
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

        // Si la referencia de pago está presente, es una actualización
        if (appointmentDetails.referenciaPago && appointmentDetails.nombre) {
            const record = await findRecordByName(appointmentDetails.nombre);
            if (record) {
                await updateAirtableRecord(record.id, { "Referencia": appointmentDetails.referenciaPago });
                console.log("Campo de Referencia en Airtable actualizado con éxito.");
            } else {
                console.log("No se encontró un registro con ese nombre para actualizar.");
            }
        } else if (appointmentDetails.nombre && appointmentDetails.telefono && appointmentDetails.fecha && appointmentDetails.hora) {
            // Si tiene todos los datos, es una nueva cita o una actualización completa
            const existingRecord = await findRecordByPhoneNumber(appointmentDetails.telefono);
            const airtableRecord = {
                "Nombre": appointmentDetails.nombre,
                "Teléfono": appointmentDetails.telefono,
                "Fecha": `${appointmentDetails.fecha}T${appointmentDetails.hora}:00`,
                "Tipo de Cita": appointmentDetails.tipoCita,
                "Referencia": appointmentDetails.referenciaPago || ""
            };

            if (existingRecord) {
                console.log("Ya existe un registro. Actualizando cita...");
                await updateAirtableRecord(existingRecord.id, airtableRecord);
                console.log("Registro en Airtable actualizado con éxito.");
            } else {
                console.log("No existe un registro. Creando nueva cita...");
                await createAirtableRecord(airtableRecord);
                console.log("Nuevo registro en Airtable creado con éxito.");
            }
        } else {
            console.log("Datos de cita incompletos o en un formato inesperado.");
        }
        
    } catch (error) {
        console.error("Error en el flujo de agendamiento:", error);
        throw error;
    }
}

// Función para encontrar un registro por número de teléfono
async function findRecordByPhoneNumber(phoneNumber) {
    try {
        const table = airtableBase('Citas');
        const records = await table.select({
            view: "Grid view",
            filterByFormula: `{Teléfono} = '${phoneNumber}'`
        }).firstPage();
        return records[0] || null;
    } catch (error) {
        console.error("Error buscando registro en Airtable por teléfono:", error);
        throw error;
    }
}

// Función para encontrar un registro por nombre
async function findRecordByName(name) {
    try {
        const table = airtableBase('Citas');
        const records = await table.select({
            view: "Grid view",
            filterByFormula: `{Nombre} = '${name}'`
        }).firstPage();
        return records[0] || null;
    } catch (error) {
        console.error("Error buscando registro en Airtable por nombre:", error);
        throw error;
    }
}

// Función para crear un nuevo registro en Airtable.
async function createAirtableRecord(details) {
    try {
        const table = airtableBase('Citas');
        const createdRecord = await table.create(details);
        return createdRecord;
    } catch (error) {
        console.error("Error creando registro en Airtable:", error);
        throw error;
    }
}

// Función para actualizar un registro existente en Airtable.
async function updateAirtableRecord(recordId, details) {
    try {
        const table = airtableBase('Citas');
        const updatedRecord = await table.update(recordId, details);
        return updatedRecord;
    } catch (error) {
        console.error("Error actualizando registro en Airtable:", error);
        throw error;
    }
}

// --- Programación de recordatorios (se mantiene) ---
cron.schedule('0 9 * * *', async () => {
    console.log('Verificando citas para enviar recordatorios...');
    const tomorrow = moment().add(1, 'day').format('YYYY-MM-DD');
    
    try {
        const records = await airtableBase('Citas').select({
            view: "Grid view",
            filterByFormula: `DATETIME_FORMAT({Fecha}, 'YYYY-MM-DD') = '${tomorrow}'`
        }).all();
        
        for (const record of records) {
            const phoneNumber = record.fields.Teléfono;
            const appointmentDate = moment(record.fields.Fecha).format('LL');
            const appointmentTime = moment(record.fields.Fecha).format('h:mm A');
            const message = `Recordatorio: Tienes una cita con el Doctor Lucas mañana, ${appointmentDate} a las ${appointmentTime}. ¡Te esperamos!`;
            
            await sendTwilioResponse(phoneNumber, process.env.TWILIO_PHONE_NUMBER, message);
            console.log(`Recordatorio enviado a ${phoneNumber}`);
        }
        
    } catch (error) {
        console.error("Error al enviar recordatorios:", error);
    }
});

// --- Función para enviar un mensaje usando la API de Twilio (se mantiene) ---
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
            await axios.post(twilioApiUrl, payload, {
                auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN }
            });
            return;
        } catch (error) {
            if (error.response?.status === 429) {
                console.error(`Error 429: Demasiadas solicitudes a Twilio. Reintento ${i + 1} de ${maxRetries}...`);
                const delay = Math.pow(2, i) * 1000;
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                } else {
                    console.error("Máximo de reintentos alcanzado para Twilio. Fallando.");
                    return;
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
});
