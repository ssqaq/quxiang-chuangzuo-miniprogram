const crypto = require("crypto");

function quote(value) {
  return String(value || "").replace(/[\r\n"]/g, "_");
}

function createMultipart(fields = [], files = []) {
  const boundary = `----wechat-miniapp-${crypto.randomBytes(12).toString("hex")}`;
  const chunks = [];
  const pushText = (value) => chunks.push(Buffer.from(String(value), "utf8"));
  const pushField = (name, value) => {
    pushText(`--${boundary}\r\n`);
    pushText(`Content-Disposition: form-data; name="${quote(name)}"\r\n\r\n`);
    pushText(value);
    pushText("\r\n");
  };
  const pushFile = (file) => {
    pushText(`--${boundary}\r\n`);
    pushText(
      `Content-Disposition: form-data; name="${quote(file.name)}"; filename="${quote(file.filename)}"\r\n`
    );
    pushText(`Content-Type: ${file.mime || "application/octet-stream"}\r\n\r\n`);
    chunks.push(Buffer.from(file.buffer || Buffer.alloc(0)));
    pushText("\r\n");
  };

  fields.forEach((field) => pushField(field.name, field.value));
  files.forEach(pushFile);
  pushText(`--${boundary}--\r\n`);
  return {
    boundary,
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

module.exports = {
  createMultipart
};
