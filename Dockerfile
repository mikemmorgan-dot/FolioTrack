# Render free tier. tesseract and poppler run as child processes, one page at
# a time, so a scanned 278-T does not load an OCR engine into the Node heap.
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
