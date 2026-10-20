package main

import "testing"

func TestResumeFlagsAndForegroundPolicy(t *testing.T) {
	request, err := parseSendArgs([]string{"--resumable", "--json", "file.bin"})
	if err != nil || !request.resumable {
		t.Fatalf("resumable flags=%+v,%v", request, err)
	}
	request, err = parseSendArgs([]string{"--resume", "aO6Ww6lyA10XmqHEgQYHyA", "file.bin"})
	if err != nil || request.resumeID == "" {
		t.Fatalf("resume flags=%+v,%v", request, err)
	}
	for _, args := range [][]string{{"--resumable", "--detach", "file.bin"}, {"--resumable", "--request-id", "request", "file.bin"}, {"--resumable", "--resume", "aO6Ww6lyA10XmqHEgQYHyA", "file.bin"}} {
		if _, err = parseSendArgs(args); err == nil {
			t.Fatalf("accepted unsupported flags:%v", args)
		}
	}
	receiver, err := parseReceiveArgs([]string{"--resume", "https://cd.yash0.in/s/aO6Ww6lyA10XmqHEgQYHyA#v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "--out", "dest"})
	if err != nil || !receiver.resume {
		t.Fatalf("receive flags=%+v,%v", receiver, err)
	}
	if _, err = resumeInvitation("12345"); err == nil {
		t.Fatal("numeric code resumedv1session")
	}
}
