import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { execSync } from 'child_process';
import * as fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// __dirname 대체 (ES 모듈 환경에서 사용)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const s3 = new S3Client({ region: 'ap-northeast-2' });

export const handler = async (event) => {
  console.log('이벤트 데이터:', JSON.stringify(event));

  const bucketName = event.Records[0].s3.bucket.name; // S3 버킷 이름
  const key = decodeURIComponent(event.Records[0].s3.object.key.replace(/\+/g, ' ')); // 업로드된 파일의 키
  const originalFileName = path.basename(key, path.extname(key)); // 파일 이름
  const tempDir = '/tmp'; // Lambda의 임시 저장 디렉토리
  const originalFilePath = `${tempDir}/${originalFileName}`; // 원본 파일 경로
  const outputHDPath = `${tempDir}/${originalFileName}_hd.mp4`; // 고화질 파일 경로
  const outputSDPath = `${tempDir}/${originalFileName}_sd.mp4`; // 저화질 파일 경로

  // FFmpeg 바이너리 경로 설정 (레이어에서 제공)
  const ffmpegPath = '/opt/bin/ffmpeg';
  
  if (fs.existsSync(ffmpegPath)) {
    console.log('FFmpeg 바이너리가 존재합니다:', ffmpegPath);
  } else {
    console.error('FFmpeg 바이너리가 존재하지 않습니다:', ffmpegPath);
  }

  try {
    // 1. S3에서 원본 동영상 다운로드
    console.log('S3에서 원본 동영상을 다운로드합니다...');
    const getObjectCommand = new GetObjectCommand({ Bucket: bucketName, Key: key });
    const data = await s3.send(getObjectCommand);

    const writeStream = fs.createWriteStream(originalFilePath);
    data.Body.pipe(writeStream);
    await new Promise((resolve) => writeStream.on('finish', resolve));
    console.log('원본 동영상이 다운로드되었습니다:', originalFilePath);

    console.log('동영상을 고화질로 변환합니다...');
const hdCmd = `${ffmpegPath} -i ${originalFilePath} -vf scale=1280:720 -c:v libx264 -preset fast -crf 23 -c:a aac -strict -2 ${outputHDPath}`;
exec(hdCmd, (error, stdout, stderr) => {
    if (error) {
        console.error('FFmpeg stderr (HD):', stderr);
        throw new Error(`고화질 변환 실패: ${error.message}`);
    }
    console.log('고화질 변환 완료:', stdout);
});


console.log('동영상을 저화질로 변환합니다...');
const sdCmd = `${ffmpegPath} -i ${originalFilePath} -vf scale=640:360 -c:v libx264 -preset fast -crf 28 -c:a aac -strict -2 ${outputSDPath}`;
exec(sdCmd, (error, stdout, stderr) => {
    if (error) {
        console.error('FFmpeg stderr (SD):', stderr);
        throw new Error(`저화질 변환 실패: ${error.message}`);
    }
    console.log('저화질 변환 완료:', stdout);
});


    // 4. 변환된 동영상을 S3에 업로드 (고화질)
    console.log('고화질 동영상을 S3에 업로드합니다...');
    const hdKey = `converted/${originalFileName}_hd.mp4`;
    const hdUploadCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: hdKey,
      Body: fs.createReadStream(outputHDPath),
      ContentType: 'video/mp4',
    });
    await s3.send(hdUploadCommand);
    console.log('고화질 동영상이 S3에 업로드되었습니다:', hdKey);

    // 5. 변환된 동영상을 S3에 업로드 (저화질)
    console.log('저화질 동영상을 S3에 업로드합니다...');
    const sdKey = `converted/${originalFileName}_sd.mp4`;
    const sdUploadCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: sdKey,
      Body: fs.createReadStream(outputSDPath),
      ContentType: 'video/mp4',
    });
    await s3.send(sdUploadCommand);
    console.log('저화질 동영상이 S3에 업로드되었습니다:', sdKey);

    // 6. 변환된 파일 경로 반환
    console.log('변환된 파일 경로를 반환합니다...');
    return {
      statusCode: 200,
      body: JSON.stringify({
        hdVideoKey: hdKey,
        sdVideoKey: sdKey,
      }),
    };
  } catch (error) {
    console.error('동영상 처리 중 오류 발생:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: '동영상 처리 중 오류가 발생했습니다.',
        error: error.message,
      }),
    };
  } finally {
    // Lambda 임시 디렉토리 정리
    [originalFilePath, outputHDPath, outputSDPath].forEach((filePath) => {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
    console.log('임시 파일이 정리되었습니다.');
  }
};
