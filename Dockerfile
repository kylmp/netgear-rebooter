FROM node:22-bullseye
ENV NODE_ENV=production
WORKDIR /app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --production --silent && mv node_modules ../
RUN apt-get update && apt-get install -y wget
COPY . .
EXPOSE 3000
CMD ["node", "netgear-rebooter.js"]
