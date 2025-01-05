FROM node:lts-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --production --silent && mv node_modules ../
RUN apk add --no-cache wget
COPY . .
EXPOSE 3000
CMD ["node", "netgear-rebooter.js"]
