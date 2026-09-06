package cli

import (
	"fmt"
	"strings"

	"cdx/src/termui"
)

func formatUnixReceiveCodeMessage(secret string, colorEnabled bool) string {
	shellSecret := strings.ReplaceAll(secret, "'", `'\''`)
	environmentCommand := termui.Color("CDX_SECRET='", termui.Cyan, colorEnabled) +
		termui.Secret(shellSecret, colorEnabled) +
		termui.Color("' cdx", termui.Cyan, colorEnabled)

	return fmt.Sprintf(`%s

Receive more securely with the code you entered:

  %s

Or enter it interactively:

  %s
  Enter receive code: %s

To allow command-line codes again, enable classic mode:

  %s

`,
		"For security, cdx does not accept receive codes on the UNIX\ncommand line because they can appear in the process list.",
		environmentCommand,
		termui.Color("cdx", termui.Cyan, colorEnabled),
		termui.Secret(secret, colorEnabled),
		termui.Color("cdx --classic", termui.Cyan, colorEnabled),
	)
}
