# Optional Docker deploy. The live Render service stays on the Node runtime;
# presidential 278-Ts are OCR'd by .github/workflows/presidential-ocr.yml.
# When this image is what runs, tesseract and poppler are on PATH and the
# app reads a scanned 278-T itself, one page at a time, outside the Node heap.
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends tesseract-ocr poppler-utils ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm run build && npm --prefix server install --omit=dev

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
