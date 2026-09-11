.PHONY: cdx cdx-release croc test

CDX_DIR := cmd/cdx
CDX_BUILD_FLAGS := -buildvcs=false -trimpath

cdx:
	cd $(CDX_DIR) && CGO_ENABLED=0 go build $(CDX_BUILD_FLAGS) -o ../../bin/cdx .

croc:
	./scripts/install-croc.sh

cdx-release:
	mkdir -p bin
	cd $(CDX_DIR) && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build $(CDX_BUILD_FLAGS) -ldflags='-s -w -buildid=' -o ../../bin/cdx-linux-amd64 .
	cd $(CDX_DIR) && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build $(CDX_BUILD_FLAGS) -ldflags='-s -w -buildid=' -o ../../bin/cdx-darwin-arm64 .
	cd $(CDX_DIR) && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build $(CDX_BUILD_FLAGS) -ldflags='-s -w -buildid=' -o ../../bin/cdx-windows-amd64.exe .

test:
	(cd $(CDX_DIR) && go test ./...)
