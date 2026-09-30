.PHONY: cd cd-release test

CD_BUILD_FLAGS := -buildvcs=false -trimpath
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
CD_VERSION_FLAGS := -X main.version=$(VERSION)
CD_RELEASE_FLAGS := -s -w -buildid= $(CD_VERSION_FLAGS)

cd:
	mkdir -p bin
	CGO_ENABLED=0 go build $(CD_BUILD_FLAGS) -ldflags='$(CD_VERSION_FLAGS)' -o bin/cd ./cmd/cd

cd-release:
	mkdir -p bin
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build $(CD_BUILD_FLAGS) -ldflags='$(CD_RELEASE_FLAGS)' -o bin/cd-linux-amd64 ./cmd/cd
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(CD_BUILD_FLAGS) -ldflags='$(CD_RELEASE_FLAGS)' -o bin/cd-linux-arm64 ./cmd/cd
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build $(CD_BUILD_FLAGS) -ldflags='$(CD_RELEASE_FLAGS)' -o bin/cd-darwin-amd64 ./cmd/cd
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build $(CD_BUILD_FLAGS) -ldflags='$(CD_RELEASE_FLAGS)' -o bin/cd-darwin-arm64 ./cmd/cd
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build $(CD_BUILD_FLAGS) -ldflags='$(CD_RELEASE_FLAGS)' -o bin/cd-windows-amd64.exe ./cmd/cd
	CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build $(CD_BUILD_FLAGS) -ldflags='$(CD_RELEASE_FLAGS)' -o bin/cd-windows-arm64.exe ./cmd/cd

test:
	go test ./...
