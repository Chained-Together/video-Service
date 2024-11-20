const express = require('express');
const upload = require('./upload-config'); // S3 파일 업로드 설정
const serverless = require('serverless-http');
const axios = require('axios');

const app = express();

app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        // 업로드된 파일 URL
        console.log(req.file)
        const fileUrl = req.file.location;

        // 사용자 메타데이터 및 업로드 결과를 기반으로 DTO 생성
        const videoDto = {
            title: req.body.title, // 브라우저에서 전달받은 비디오 제목
            description: req.body.description, // 브라우저에서 전달받은 비디오 설명
            fileUrl: fileUrl, // S3에 저장된 파일 URL
        };

        // 업로드가 완료되면 바로 응답을 보내고, 나중에 비동기적으로 비디오 생성 작업을 처리하도록 할 수 있습니다.
        res.status(200).json({
            message: 'File uploaded successfully',
            fileUrl: fileUrl,
        });

        // 비디오 생성은 비동기적으로 처리 (따로 실행)
        const createVideoResponse = await axios.post('https://localhost:3001/video', videoDto);
    } catch (error) {
        console.error('Error during upload or video creation:', error);
        res.status(500).json({
            message: 'File upload or video creation failed',
            error: error.message,
        });
    }
});

exports.handler = serverless(app);
