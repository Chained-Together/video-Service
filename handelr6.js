import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import axios from "axios";

const execPromise = promisify(exec);
const SOURCE_BUCKET = "15-final-project"; // 원본 버킷
const DESTINATION_BUCKET = "finish-video"; // 대상 버킷
const SIGNED_URL_TIMEOUT = 60;

const s3Client = new S3Client({ region: "ap-northeast-2" });

export const handler = async (event) => {
    try {
        // 1. 원본 파일 경로 추출
        const s3SourceKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
        if (!s3SourceKey.startsWith("uploads/")) {
            throw new Error("원본 파일이 uploads/ 폴더에 없습니다.");
        }
        console.log("원본 파일 확인 완료:", s3SourceKey);

        const s3SourceBasename = path.basename(s3SourceKey, path.extname(s3SourceKey));
        console.log("원본 파일 이름:", s3SourceBasename);

        // 2. S3의 원본 파일 서명된 URL 생성
        const getObjectCommand = new GetObjectCommand({
            Bucket: SOURCE_BUCKET,
            Key: s3SourceKey,
        });
        const s3SourceSignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
            expiresIn: SIGNED_URL_TIMEOUT,
        });

        console.log("S3 원본 파일 서명된 URL 생성 완료:", s3SourceSignedUrl);

        // 3. FFmpeg 경로 확인
        const ffmpegPath = "/opt/ffmpeg-7.0.2-amd64-static/ffmpeg";
        if (!fs.existsSync(ffmpegPath)) {
            throw new Error("FFmpeg 바이너리가 /opt/ffmpeg-7.0.2-amd64-static에 없습니다.");
        }

        console.log("FFmpeg 확인 완료");

        // 4. 원본 영상 길이 확인
        const videoInfoCmd = `${ffmpegPath} -i "${s3SourceSignedUrl}" 2>&1 | grep Duration`;
        const videoInfo = await execPromise(videoInfoCmd);
        const durationMatch = videoInfo.stdout.match(/Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (!durationMatch) {
            throw new Error("원본 영상의 길이를 가져올 수 없습니다.");
        }

        const [, hours, minutes, seconds] = durationMatch.map(Number);
        const totalDuration = hours * 3600 + minutes * 60 + seconds;
        console.log("원본 영상 길이 (초):", totalDuration);

        // 5. 10초로 자르기
        const trimmedPath = `/tmp/trimmed_${s3SourceBasename}.ts`;
        if (totalDuration > 10) {
            const trimCmd = `${ffmpegPath} -i "${s3SourceSignedUrl}" -t 10 -c:v copy -c:a copy ${trimmedPath}`;
            console.log("10초로 자르는 FFmpeg 명령어:", trimCmd);

            await execPromise(trimCmd);
            console.log("10초로 자르기 완료");

            if (!fs.existsSync(trimmedPath)) {
                throw new Error("10초로 자른 파일이 생성되지 않았습니다.");
            }
        }

        const sourceFilePath = totalDuration > 10 ? trimmedPath : s3SourceSignedUrl;
        console.log("처리할 원본 파일 경로:", sourceFilePath);

        // 6. 고화질(720p) 변환
        const highResPath = `/tmp/high_${s3SourceBasename}_720p.ts`;
        const highResCmd = `${ffmpegPath} -i "${sourceFilePath}" -vf scale=1280:720 -c:v libx264 -preset fast -crf 20 -c:a aac -strict experimental ${highResPath}`;
        console.log("고화질 변환 FFmpeg 명령어:", highResCmd);

        await execPromise(highResCmd);
        console.log("고화질 변환 완료");

        if (!fs.existsSync(highResPath)) {
            throw new Error("고화질 출력 파일이 생성되지 않았습니다.");
        }

        const highResSize = fs.statSync(highResPath).size;
        if (highResSize === 0) {
            throw new Error("고화질 출력 파일 크기가 0입니다.");
        }
        console.log("고화질 출력 파일 크기:", highResSize);

        // 7. 저화질(360p) 변환
        const lowResPath = `/tmp/low_${s3SourceBasename}_360p.ts`;
        const lowResCmd = `${ffmpegPath} -i "${sourceFilePath}" -vf scale=640:360 -c:v libx264 -preset fast -crf 23 -c:a aac -strict experimental ${lowResPath}`;
        console.log("저화질 변환 FFmpeg 명령어:", lowResCmd);

        await execPromise(lowResCmd);
        console.log("저화질 변환 완료");

        if (!fs.existsSync(lowResPath)) {
            throw new Error("저화질 출력 파일이 생성되지 않았습니다.");
        }

        const lowResSize = fs.statSync(lowResPath).size;
        if (lowResSize === 0) {
            throw new Error("저화질 출력 파일 크기가 0입니다.");
        }
        console.log("저화질 출력 파일 크기:", lowResSize);

        // 8. 고화질 S3 업로드
        const highResUploadCommand = new PutObjectCommand({
            Bucket: DESTINATION_BUCKET,
            Key: `high/${s3SourceBasename}_720p.ts`,
            Body: fs.createReadStream(highResPath),
            ContentType: "video/mp2t",
        });
        await s3Client.send(highResUploadCommand);
        console.log("고화질 업로드 완료");

        const highResUrl = `https://${DESTINATION_BUCKET}.s3.amazonaws.com/high/${s3SourceBasename}_720p.ts`;

        // 9. 저화질 S3 업로드
        const lowResUploadCommand = new PutObjectCommand({
            Bucket: DESTINATION_BUCKET,
            Key: `low/${s3SourceBasename}_360p.ts`,
            Body: fs.createReadStream(lowResPath),
            ContentType: "video/mp2t",
        });
        await s3Client.send(lowResUploadCommand);
        console.log("저화질 업로드 완료");

        const lowResUrl = `https://${DESTINATION_BUCKET}.s3.amazonaws.com/low/${s3SourceBasename}_360p.ts`;

        console.log("고화질 URL:", highResUrl);
        console.log("저화질 URL:", lowResUrl);

        // 10. 메인 서버로 결과 전달
        const apiUrl = "https://0799-222-104-17-160.ngrok-free.app/api/video/update-metadata";
        const payload = {
            highResolutionUrl: highResUrl,
            lowResolutionUrl: lowResUrl,
            metadata: {
                videoCode: `uploads/${s3SourceBasename}`, // 비디오 코드
                duration: totalDuration, // 계산된 영상 길이 (초 단위)
            },
        };

        console.log("메인 서버로 요청 보낼 데이터:", payload);

        try {
            const response = await axios.post(apiUrl, payload);
            console.log("메인 서버 응답:", response.data);
        } catch (error) {
            console.error("메인 서버로 데이터 전송 실패:", error.response ? error.response.data : error.message);
            throw new Error("메인 서버와의 통신 실패");
        }

        return {
            statusCode: 200,
            body: JSON.stringify("Lambda 처리 및 메인 서버 전송 완료"),
        };
    } catch (error) {
        console.error("파일 처리 중 오류 발생:", error);

        return {
            statusCode: 500,
            body: JSON.stringify({
                message: "파일 처리 중 오류 발생",
                error: error.message,
            }),
        };
    }
};
