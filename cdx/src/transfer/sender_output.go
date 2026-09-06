package transfer

import (
	"fmt"
	"strings"

	"cdx/src/termui"
)

const (
	secretColorPrefix = termui.Yellow
	colorReset        = termui.Reset
)

func colorSecret(secret string, enabled bool) string {
	if !enabled {
		return secret
	}
	return termui.Secret(secret, true)
}

func formatSendInstructions(secret, flags, webURL, clipboardNotice string, colorEnabled bool) string {
	if clipboardNotice != "" {
		clipboardNotice = " (" + clipboardNotice + ")"
	}
	webSection := ""
	if webURL != "" {
		webSection = fmt.Sprintf("\nOr open:\n  %s\n", webURL)
	}
	return fmt.Sprintf(`On the other computer, run:
  cdx %[2]s%[1]s%[4]s
%[5]s`, colorSecret(secret, colorEnabled), flags, webURL, clipboardNotice, webSection)
}

func formatClipboardText(secret, flags string, extended bool) string {
	if !extended {
		return secret
	}
	return fmt.Sprintf("CDX_SECRET=%q cdx %s", secret, strings.TrimSpace(flags))
}
