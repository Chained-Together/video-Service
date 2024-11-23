import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import axios from "axios"; // HTTP 요청을 위해 axios 사용

const execPromise = promisify(exec);
const S3_DESTINATION_BUCKET = "finish-video";
const SIGNED_URL_TIMEOUT = 60;

// S3 클라이언트 생성
const s3Client = new S3Client({ region: "ap-northeast-2" });

export const handler = async (event) => {
    try {
        // S3 이벤트에서 버킷과 객체 키를 추출
        const s3SourceBucket = event.Records[0].s3.bucket.name;
        const s3SourceKey = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, " "));
        const s3SourceBasename = path.basename(s3SourceKey, path.extname(s3SourceKey));
        const highS3DestinationFilename = `high/${s3SourceBasename}_cfr.ts`; // high 폴더에 저장
        const highResolution = 'scale=1280:720';
        const lowResolution = 'scale=640:360';

        console.log("S3 Source Bucket:", s3SourceBucket);
        console.log("S3 Source Key:", s3SourceKey);

        // S3 객체에 대한 서명된 URL 생성
        const getObjectCommand = new GetObjectCommand({
            Bucket: s3SourceBucket,
            Key: s3SourceKey,
        });
        const s3SourceSignedUrl = await getSignedUrl(s3Client, getObjectCommand, {
            expiresIn: SIGNED_URL_TIMEOUT,
        });

        console.log("S3 Source Signed URL 생성 완료:", s3SourceSignedUrl);

        // ffmpeg가 예상된 디렉토리에 있는지 확인
        const ffmpegPath = "/opt/ffmpeg-7.0.2-amd64-static/ffmpeg";
        if (!fs.existsSync(ffmpegPath)) {
            throw new Error("FFmpeg 바이너리가 /opt/ffmpeg-7.0.2-amd64-static에 없습니다.");
        }

        console.log("FFmpeg 확인 완료");

        // FFmpeg 명령어 정의
        const highOutputPath = "/tmp/highOutput.ts";
        const lowOutputPath = "/tmp/lowOutput.ts"
        const highFfmpegCmd = `${ffmpegPath} -i "${s3SourceSignedUrl}" -vf "${highResolution}" -c:v libx264 -preset fast -crf 20 -af aresample=async=1:first_pts=0 -f mpegts "${highOutputPath}"`;
        const lowFfmpegCmd = `${ffmpegPath} -i "${s3SourceSignedUrl}" -vf "${lowResolution}" -c:v libx264 -preset fast -crf 20 -af aresample=async=1:first_pts=0 -f mpegts "${lowOutputPath}"`;
        console.log("고화질 FFmpeg 명령어:", highFfmpegCmd);
        console.log("저화질 FFmpeg 명령어:", lowFfmpegCmd);

        // FFmpeg 실행
        console.log("FFmpeg 프로세스 실행 중...");
        const { highStdout, highStderr } = await execPromise(highFfmpegCmd);
        const { lowStdout, lowStderr } = await execPromise(lowFfmpegCmd);

        console.log("highFFmpeg stdout:", highStdout);
        if (stderr) {
            console.error("highFFmpeg stderr:", highStderr);
        }

        console.log("lowFFmpeg stdout:", lowStdout);
        if (stderr) {
            console.error("lowFFmpeg stderr:", lowStderr);
        }

        // FFmpeg 출력 파일 확인
        if (!fs.existsSync(outputPath)) {
            throw new Error("FFmpeg 출력 파일이 생성되지 않았습니다.");
        }

        // 출력 파일 크기 확인
        const fileSize = fs.statSync(outputPath).size;
        console.log("FFmpeg 출력 파일 크기:", fileSize);

        if (fileSize === 0) {
            throw new Error("FFmpeg 출력 파일 크기가 0입니다.");
        }

        // S3로 업로드할 스트림 준비
        const s3PutObjectCommand = new PutObjectCommand({
            Bucket: S3_DESTINATION_BUCKET,
            Key: s3DestinationFilename, // high 폴더에 저장
            Body: fs.createReadStream(outputPath), // 파일 스트림 사용
            ContentType: "video/mp2t", // 콘텐츠 타입 설정
        });

        console.log("S3 업로드 명령 생성 완료:", s3PutObjectCommand);

        // 처리된 파일을 S3로 업로드
        await s3Client.send(s3PutObjectCommand);

        console.log("S3 업로드 완료");

        // 업로드된 파일 URL 생성
        const uploadedFileUrl = `https://${S3_DESTINATION_BUCKET}.s3.amazonaws.com/${s3DestinationFilename}`;
        console.log("업로드된 파일 URL:", uploadedFileUrl);

        // 메인 서버로 업로드 결과 전달
        const apiUrl = "https://your-main-server.com/api/video/update-metadata"; // 메인 서버의 API URL
        const payload = {
            highResolutionUrl: uploadedFileUrl, // S3에 업로드된 파일 URL
            metadata: {
                videoCode: s3SourceBasename, // 비디오 코드만 전달
            },
        };

        console.log("메인 서버로 요청 보낼 데이터:", payload);

        const response = await axios.post(apiUrl, payload);
        console.log("메인 서버 응답:", response.data);

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
