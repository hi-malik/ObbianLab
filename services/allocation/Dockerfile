FROM golang:1.27.2-bookworm AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /allocation ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /allocation /allocation
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["/allocation"]
