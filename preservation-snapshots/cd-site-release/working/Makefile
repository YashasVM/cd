.PHONY: cdx cdx-release test

CDX_BUILD_FLAGS := -buildvcs=false -trimpath
VERSION ?= dev
CDX_RELEASE_FLAGS := -s -w -buildid= -X main.version=$(VERSION)

cdx:
	mkdir -p bin
	CGO_ENABLED=0 go build $(CDX_BUILD_FLAGS) -o bin/cdx ./cmd/cdx

cdx-release:
	mkdir -p bin
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build $(CDX_BUILD_FLAGS) -ldflags='$(CDX_RELEASE_FLAGS)' -o bin/cdx-linux-amd64 ./cmd/cdx
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(CDX_BUILD_FLAGS) -ldflags='$(CDX_RELEASE_FLAGS)' -o bin/cdx-linux-arm64 ./cmd/cdx
	CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build $(CDX_BUILD_FLAGS) -ldflags='$(CDX_RELEASE_FLAGS)' -o bin/cdx-darwin-amd64 ./cmd/cdx
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build $(CDX_BUILD_FLAGS) -ldflags='$(CDX_RELEASE_FLAGS)' -o bin/cdx-darwin-arm64 ./cmd/cdx
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build $(CDX_BUILD_FLAGS) -ldflags='$(CDX_RELEASE_FLAGS)' -o bin/cdx-windows-amd64.exe ./cmd/cdx
	CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build $(CDX_BUILD_FLAGS) -ldflags='$(CDX_RELEASE_FLAGS)' -o bin/cdx-windows-arm64.exe ./cmd/cdx

test:
	go test ./...
