const express = require('express');
const upload = require('./upload-config');

const app = express();

app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ limit: '100mb', extended: true }));

app.post('/upload', upload.single('file'), (req, res) => {
    try {
        const fileUrl = req.file.location;
        res.status(200).json({ message: 'File uploaded successfully', url: fileUrl });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ message: 'File upload failed', error: error.message });
    }
});

app.listen(3999, () => {
    console.log('서버가 실행되고있습니다. http://localhost:3999');
});
