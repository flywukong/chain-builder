FROM node:20-alpine AS build
WORKDIR /app
ARG VITE_WS_URL=ws://localhost/ws
ENV VITE_WS_URL=$VITE_WS_URL
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx-frontend.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
