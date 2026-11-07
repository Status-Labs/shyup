FROM node:24-slim
WORKDIR /app
COPY src ./src
COPY package.json ./
ENV SHYUP_DB=/data/shyup.db PORT=4000 HOST=0.0.0.0
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 4000
USER node
CMD ["node", "src/cli.ts", "serve"]
