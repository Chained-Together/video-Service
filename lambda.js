import pkg from "@aws-sdk/client-mediaconvert";
import {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import axios from "axios";
import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
const { MediaConvertClient, CreateJobCommand, DescribeEndpointsCommand } = pkg;

const execPromise = promisify(exec);

const SOURCE_BUCKET = process.env.SOURCE_BUCKET;
const DESTINATION_BUCKET = process.env.DESTINATION_BUCKET;
const REGION = process.env.REGION;
const JOB_SETTINGS_PATH = "job.json";
const API_URL = process.env.API_URL;
const CLOUDFRONT_DOMAIN = process.env.CLOUDFRONT_DOMAIN;
const FFMPEG_PATH = process.env.FFMPEG_PATH;
const FFPROBE_PATH = process.env.FFPROBE_PATH;

const s3Client = new S3Client({ region: REGION });

const downloadFileFromS3 = async (bucket, key, localPath) => {
  const params = { Bucket: bucket, Key: key };
  const { Body } = await s3Client.send(new GetObjectCommand(params));
  const fileStream = fs.createWriteStream(localPath);

  return new Promise((resolve, reject) => {
    Body.pipe(fileStream).on("finish", resolve).on("error", reject);
  });
};

const getVideoThumbnailWithFFmpeg = async (filePath, outputThumbnailPath) => {
  try {
    const command = `${FFMPEG_PATH} -i "${filePath}" -ss 00:00:01 -vframes 1 "${outputThumbnailPath}"`;
    await execPromise(command);
    console.log("썸네일이 성공적으로 생성되었습니다:", outputThumbnailPath);
  } catch (error) {
    console.error("FFmpeg으로 썸네일 생성 실패:", error);
    throw new Error("FFmpeg으로 썸네일을 생성하지 못했습니다.");
  }
};

const getVideoDurationWithFFmpeg = async (filePath) => {
  try {
    const command = `${FFPROBE_PATH} -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`;
    const { stdout, stderr } = await execPromise(command);
    if (stderr) {
      console.error("ffprobe 오류:", stderr);
      throw new Error("ffprobe로 비디오 길이를 추출할 수 없습니다.");
    }

    const duration = parseFloat(stdout);
    if (isNaN(duration)) {
      throw new Error("비디오 길이를 올바르게 읽을 수 없습니다.");
    }

    return duration;
  } catch (error) {
    console.error("비디오 길이 추출 실패:", error);
    throw new Error("비디오 길이를 추출하는 중 오류 발생");
  }
};

const getMediaConvertClient = async () => {
  const mediaConvertClient = new MediaConvertClient({ region: REGION });
  const { Endpoints } = await mediaConvertClient.send(
    new DescribeEndpointsCommand({})
  );
  if (!Endpoints || Endpoints.length === 0) {
    throw new Error("MediaConvert 엔드포인트를 가져올 수 없습니다.");
  }
  return new MediaConvertClient({
    region: REGION,
    endpoint: Endpoints[0]?.Url,
  });
};

const pollForHlsAndThumbnailFiles = async (
  bucket,
  hlsKey,
  thumbnailKey,
  interval = 10000,
  maxAttempts = 5
) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(
        `[시도 ${attempt}] 파일 확인: HLS - ${hlsKey}, 썸네일 - ${thumbnailKey}`
      );

      await Promise.all([
        s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: hlsKey })),
        s3Client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: thumbnailKey })
        ),
      ]);

      console.log(
        `[성공] HLS와 썸네일 파일이 모두 존재합니다: ${hlsKey}, ${thumbnailKey}`
      );
      return true;
    } catch (error) {
      if (error.name === "NotFound") {
        console.log(
          `[파일 없음] 아직 파일이 생성되지 않았습니다. ${interval}ms 후 재시도합니다.`
        );
      } else {
        console.error(
          `[오류] 파일 확인 중 예기치 못한 오류 발생:`,
          error.message
        );
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  console.error(
    `[실패] ${maxAttempts}번 시도 후에도 HLS 또는 썸네일 파일을 찾을 수 없습니다.`
  );
  return false;
};

// 파일을 S3에 업로드하는 함수
const uploadFileToS3 = async (bucket, key, localPath) => {
  const fileStream = fs.createReadStream(localPath);
  const uploadParams = {
    Bucket: bucket,
    Key: key,
    Body: fileStream,
  };

  try {
    const upload = new Upload({
      client: s3Client,
      params: uploadParams,
    });

    await upload.done(); // 업로드 완료를 기다립니다.
    console.log(`파일을 S3에 업로드 완료: ${key}`);
  } catch (error) {
    console.error("파일 업로드 중 오류 발생:", error);
    throw new Error("파일 업로드에 실패했습니다.");
  }
};

export const handler = async (event) => {
  try {
    const s3SourceKey = decodeURIComponent(
      event.Records[0].s3.object.key.replace(/\+/g, " ")
    );
    if (!s3SourceKey.startsWith("uploads/"))
      throw new Error("원본 파일이 uploads/ 폴더에 없습니다.");

    console.log("원본 파일 확인 완료:", s3SourceKey);

    const s3SourceBasename = path.basename(
      s3SourceKey,
      path.extname(s3SourceKey)
    );
    const localFilePath = `/tmp/${path.basename(s3SourceKey)}`;
    await downloadFileFromS3(SOURCE_BUCKET, s3SourceKey, localFilePath);

    console.log("파일 다운로드 완료:", localFilePath);

    // 썸네일 추출
    const thumbnailLocalPath = `/tmp/${s3SourceBasename}_thumbnail.jpg`;
    await getVideoThumbnailWithFFmpeg(localFilePath, thumbnailLocalPath);

    // 썸네일을 S3에 업로드
    const thumbnailKey = `${s3SourceBasename}/${s3SourceBasename}thumbnail.jpg`;
    await uploadFileToS3(DESTINATION_BUCKET, thumbnailKey, thumbnailLocalPath);

    console.log("썸네일 업로드 완료:", thumbnailKey);

    let duration;
    try {
      duration = await getVideoDurationWithFFmpeg(localFilePath);
    } catch (err) {
      console.warn("동영상 길이를 확인하지 못했습니다. 기본값으로 설정합니다.");
      duration = 10;
    }

    console.log(`동영상 길이: ${duration}초`);

    const mediaConvertClient = await getMediaConvertClient();
    const jobSettings = JSON.parse(fs.readFileSync(JOB_SETTINGS_PATH, "utf8"));
    console.log(jobSettings);

    jobSettings.Inputs[0].FileInput = `s3://${SOURCE_BUCKET}/${s3SourceKey}`;

    console.log("Input File Path:", jobSettings.Inputs[0].FileInput);

    if (duration > 10) {
      jobSettings.Inputs[0].InputClippings = [
        {
          StartTimecode: "00:00:00:00",
          EndTimecode: "00:00:10:00",
        },
      ];
    } else {
      jobSettings.Inputs[0].InputClippings = [];
    }

    jobSettings.OutputGroups.forEach((group) => {
      if (group.OutputGroupSettings?.HlsGroupSettings) {
        group.OutputGroupSettings.HlsGroupSettings.Destination = `s3://${DESTINATION_BUCKET}/${s3SourceBasename}/`;
      }

      if (group.OutputGroupSettings?.FileGroupSettings) {
        group.OutputGroupSettings.FileGroupSettings.Destination = `s3://${DESTINATION_BUCKET}/${s3SourceBasename}/`;
      }
    });

    const job = await mediaConvertClient.send(
      new CreateJobCommand({
        Role: "arn:aws:iam::412381761158:role/mediaconver_role",
        Settings: jobSettings,
      })
    );

    console.log("MediaConvert Job created:", job);

    const hlsMasterFileKey = `${s3SourceBasename}/${s3SourceBasename}.m3u8`;

    const fileExists = await pollForHlsAndThumbnailFiles(
      DESTINATION_BUCKET,
      hlsMasterFileKey,
      thumbnailKey,
      10000,
      5
    );
    if (!fileExists) {
      throw new Error("HLS 변환 파일이 S3에 존재하지 않습니다.");
    }
    console.log("HLS 파일이 성공적으로 생성되었습니다.");

    const resolutionManifestUrl = `https://${CLOUDFRONT_DOMAIN}/${hlsMasterFileKey}`;
    const finalDuration = duration > 10 ? 10 : duration;

    const payload = {
      videoUrl: resolutionManifestUrl,
      metadata: {
        videoCode: `uploads/${s3SourceBasename}`,
        duration: Math.floor(finalDuration),
        thumbnail: `https://${CLOUDFRONT_DOMAIN}/${thumbnailKey}`,
      },
    };

    console.log("메인 서버로 요청 보낼 데이터:", payload);

    const response = await axios.post(API_URL, payload);
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
