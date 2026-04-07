FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./

RUN test -f "public/pis-logo.png"
RUN test -f "public/PITS WHITE (1) 1-2.png"
RUN test -f "public/pits-white-logo.png"

RUN npm run build

EXPOSE 3000

CMD ["npm", "start"]
