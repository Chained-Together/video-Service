const multer = require('multer');
const multerS3 = require('multer-s3');
const s3 = require('./aws-config');
const { PutObjectCommand } = require('@aws-sdk/client-s3');

const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.S3_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        metadata: (req, file, cb) => {
            cb(null, { fieldName: file.fieldname });
        },
        key: (req, file, cb) => {
            const fileName = `uploads/${Date.now()}_${file.originalname}`;
            cb(null, fileName);
        },
    }),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('비디오 타입만 허용됩니다.'));
        }
    },
});

module.exports = upload;
