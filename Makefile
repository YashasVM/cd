.PHONY: cdx cd cdx-release test

CD_BUILD_FLAGS := -buildvcs=false -trimpath
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
CD_VERSION_FLAGS := -X main.version=$(VERSION)
CD_RELEASE_FLAGS := -s -w -buildid= $(CD_VERSION_FLAGS)
PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

cdx:
	mkdir -p bin
	CGO_ENABLED=0 go build $(CD_BUILD_FLAGS) -ldflags='$(CD_VERSION_FLAGS)' -o bin/cdx ./cmd/cdx

# Old target name, kept for muscle memory.
cd: cdx

cdx-release:
	mkdir -p bin
	$(foreach platform,$(PLATFORMS),CGO_ENABLED=0 GOOS=$(word 1,$(subst /, ,$(platform))) GOARCH=$(word 2,$(subst /, ,$(platform))) go build $(CD_BUILD_FLAGS) -ldflags='$(CD_RELEASE_FLAGS)' -o bin/cdx-$(subst /,-,$(platform))$(if $(findstring windows,$(platform)),.exe) ./cmd/cdx &&) true

test:
	go test ./...
