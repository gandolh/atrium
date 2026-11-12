import fastifyMultipart from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { MAX_UPLOAD_BYTES } from "../config.js";

/**
 * Multipart uploads, app-wide: one file per request, up to `MAX_UPLOAD_MB`
 * (D15). @fastify/multipart truncates past the limit; the upload routes read
 * `file.truncated` and answer 413.
 */
const multipartUploads: FastifyPluginAsync = async (app) => {
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
};

export const multipart = fp(multipartUploads, { name: "multipart" });
