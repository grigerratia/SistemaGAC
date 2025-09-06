// Importa las librerías necesarias.
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const cron = require('node-cron');
const moment = require('moment');
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
        const existingRecord = await findRecordByPhoneNumber(appointmentDetails.telefono);

        if (existingRecord) {
            console.log("Ya existe un registro. Actualizando cita...");
            await updateAirtableRecord(existingRecord.id, appointmentDetails);
            console.log("Registro en Airtable actualizado con éxito.");
        } else {
            console.log("No existe un registro. Creando nueva cita...");
            await createAirtableRecord(appointmentDetails);
            console.log("Nuevo registro en Airtable creado con éxito.");
        }
        
        // Genera el PDF después de guardar/actualizar la cita
        await createCalendarPDF(appointmentDetails.fecha);
        console.log("PDF del calendario generado con éxito.");

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
        console.error("Error buscando registro en Airtable:", error);
        throw error;
    }
}

// Función para crear un nuevo registro en Airtable.
async function createAirtableRecord(details) {
    try {
        const table = airtableBase('Citas');
        const createdRecord = await table.create({
            "Nombre": details.nombre,
            "Teléfono": details.telefono,
            "Fecha": `${details.fecha}T${details.hora}:00`
        });
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
        const updatedRecord = await table.update(recordId, {
            "Nombre": details.nombre,
            "Fecha": `${details.fecha}T${details.hora}:00`
        });
        return updatedRecord;
    } catch (error) {
        console.error("Error actualizando registro en Airtable:", error);
        throw error;
    }
}

// --- Nueva funcionalidad: Generación de PDF de calendario ---
async function createCalendarPDF(date) {
    try {
        console.log('Iniciando la generación del PDF...');
        const doc = new PDFDocument();
        const startOfMonth = moment(date).startOf('month');
        const fileName = `calendario_citas_${startOfMonth.format('YYYY-MM')}.pdf`;

        doc.pipe(fs.createWriteStream(path.join(__dirname, fileName)));

        // Título del documento
        doc.fontSize(25).text(`Calendario de Citas`, { align: 'center' });
        doc.fontSize(20).text(`${startOfMonth.format('MMMM YYYY')}`, { align: 'center' });
        doc.moveDown();

        const tableTop = doc.y;
        const colWidth = 75;
        const rowHeight = 70;
        const left = 50;

        const headers = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
        doc.font('Helvetica-Bold');
        headers.forEach((header, i) => {
            doc.text(header, left + i * colWidth, tableTop, { width: colWidth, align: 'center' });
        });
        doc.font('Helvetica');
        doc.rect(left, tableTop + 20, colWidth * 7, 1).fill('#000');
        
        const filterMonth = startOfMonth.format('YYYY-MM');
        console.log(`Buscando citas para el mes: ${filterMonth}`);
        const records = await airtableBase('Citas').select({
            view: "Grid view",
            filterByFormula: `DATETIME_FORMAT({Fecha}, 'YYYY-MM') = '${filterMonth}'`
        }).all();
        
        if (records.length === 0) {
            console.log("No se encontraron citas para este mes.");
            doc.moveDown(2).text('No hay citas agendadas para este mes.');
        } else {
            console.log(`Se encontraron ${records.length} citas.`);
        }
        
        // Proceso de dibujo del calendario y citas
        let currentDay = startOfMonth.clone();
        let currentRow = 0;
        while (currentDay.isSame(startOfMonth, 'month')) {
            const dayOfWeek = currentDay.weekday();
            const x = left + dayOfWeek * colWidth;
            const y = tableTop + 25 + currentRow * rowHeight;
            doc.text(currentDay.format('DD'), x + 5, y + 5);
            
            const citasDelDia = records.filter(record => moment(record.fields.Fecha).isSame(currentDay, 'day'));
            let textY = y + 20;
            citasDelDia.forEach(cita => {
                doc.fontSize(8).text(`${moment(cita.fields.Fecha).format('HH:mm')} - ${cita.fields.Nombre}`, x + 5, textY, { width: colWidth - 5, lineGap: 0 });
                textY += 10;
            });
            
            // Dibuja la celda del calendario
            doc.rect(x, y, colWidth, rowHeight).stroke('#ccc');

            if (dayOfWeek === 6) {
                currentRow++;
            }
            currentDay.add(1, 'day');
        }

        doc.end();

    } catch (error) {
        console.error("Error generando PDF:", error.message);
    }
}

// --- Nueva funcionalidad: Programación de recordatorios ---
cron.schedule('0 9 * * *', async () => { // Se ejecuta todos los días a las 9:00 AM
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
            const message = `Recordatorio: Tienes una cita con ${record.fields.Nombre} mañana, ${appointmentDate} a las ${appointmentTime}. ¡Te esperamos!`;
            
            await sendTwilioResponse(phoneNumber, process.env.TWILIO_PHONE_NUMBER, message);
            console.log(`Recordatorio enviado a ${phoneNumber}`);
        }
        
    } catch (error) {
        console.error("Error al enviar recordatorios:", error);
    }
});

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
            return;
        } catch (error) {
            if (error.response && error.response.status === 429) {
                console.error(`Error 429: Demasiadas solicitudes a Twilio. Reintento ${i + 1} de ${maxRetries}...`);
                const delay = Math.pow(2, i) * 1000;
                if (i < maxRetries - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                } else {
                    console.error("Máximo de reintentos alcanzado para Twilio. Fallando. Se ignorará el error para no detener el flujo de la aplicación.");
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
    console.log(`Ahora el PDF se generará automáticamente.`);
});
