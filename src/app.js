const express = require('express');
    const bodyParser = require('body-parser');
    const axios = require('axios');
    require('dotenv').config();

    const app = express();
    const port = process.env.PORT || 3000;

    app.use(bodyParser.urlencoded({ extended: false }));
    app.use(bodyParser.json());

    // Asegúrate de que tus credenciales estén en el archivo .env
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
    const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
    const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

    // Lógica para enviar mensajes de Twilio
    const sendMessage = async (to, message) => {
        const Twilio = require('twilio');
        const client = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

        try {
            await client.messages.create({
                from: TWILIO_PHONE_NUMBER,
                to: to,
                body: message,
            });
            console.log('Mensaje enviado con éxito a:', to);
        } catch (error) {
            console.error('Error al enviar el mensaje:', error.message);
        }
    };

    // Lógica para comunicarse con la API de Gemini
    const generateGeminiResponse = async (userMessage) => {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
        const headers = { 'Content-Type': 'application/json' };
        
        // Aquí está el prompt que corrige los problemas que tuviste
        const systemPrompt = `Eres un asistente de citas para un consultorio oftalmológico. Mantén un tono profesional, amable y conciso. Tu única función es agendar citas. No respondas a preguntas médicas, de facturación o de otro tipo que no sean agendar. En esos casos, pide amablemente que el cliente se comunique directamente con el consultorio.
        
        Actúa como el asistente del consultorio. Basado en el siguiente mensaje, decide si su intención es agendar una cita o no.

        Instrucciones para agendar:
        El asistente ofrece las citas en el consultorio de lunes a viernes de 8:00 AM a 11:00 AM. Las citas a domicilio son de lunes a viernes de 3:00 PM a 7:00 PM. El costo de la consulta es de 25 dólares. Si el cliente quiere agendar una cita, responde que le vas a enviar un enlace para que pueda hacerlo. Luego, pega este enlace: https://calendly.com/tu-nombre/cita-con-el-doctor

        Instrucciones para mensajes incompletos:
        Si el mensaje del cliente es una solicitud de cita pero carece de detalles como el día, la hora o el tipo de cita, debes pedir amablemente más información para poder ayudarle a agendar.
         
        Instrucciones para otros casos:
        Si el mensaje no es sobre agendar, responde amablemente que tu función es solo agendar citas y pide que se comunique al consultorio para otras consultas.

        Instrucción de longitud: Tu respuesta no debe exceder los 1500 caracteres.
        `;

        const payload = {
            contents: [{ parts: [{ text: userMessage }] }],
            tools: [{ "google_search": {} }],
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
        };

        try {
            const response = await axios.post(url, payload, { headers });
            return response.data.candidates[0].content.parts[0].text;
        } catch (error) {
            console.error('Error al generar la respuesta de Gemini:', error.response ? error.response.data : error.message);
            return 'Lo siento, hubo un problema al procesar su solicitud. Por favor, intente de nuevo más tarde.';
        }
    };

    app.post('/whatsapp-webhook', async (req, res) => {
        const from = req.body.From;
        const messageBody = req.body.Body;
        
        if (!from || !messageBody) {
            return res.status(400).send('Mensaje o remitente no válido.');
        }

        console.log(`Mensaje recibido de ${from}: ${messageBody}`);

        try {
            const aiResponse = await generateGeminiResponse(messageBody);
            await sendMessage(from, aiResponse);
            res.status(200).send('Mensaje procesado y respuesta enviada.');
        } catch (error) {
            console.error('Error en el webhook:', error);
            res.status(500).send('Error interno del servidor.');
        }
    });

    app.listen(port, () => {
        console.log(`Servidor escuchando en http://localhost:${port}`);
    });