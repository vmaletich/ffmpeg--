# FFmpeg image + Node
FROM jrottenberg/ffmpeg:6.1-alpine

RUN apk add --no-cache nodejs npm

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
