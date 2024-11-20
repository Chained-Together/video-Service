const express = require('express');
const upload = require('./upload-config');
const serverless = require('serverless-http');

const app = express();

app.post('/upload', upload.single('file'), (req, res) => {
    try {
        const fileUrl = req.file.location;
        res.status(200).json({ message: 'File uploaded successfully', url: fileUrl });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ message: 'File upload failed', error: error.message });
    }
});

exports.handler = serverless(app);
