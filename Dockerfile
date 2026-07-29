FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js default-policy.js ./
COPY public ./public
RUN mkdir -p data && touch data/.gitkeep
EXPOSE 3100
CMD ["node", "server.js"]
