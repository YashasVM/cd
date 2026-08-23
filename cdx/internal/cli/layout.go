package cli

// These layout identifiers preserve the help customization fields used by the
// parser while keeping cdx's renderer independent of text/template.
var (
	AppHelpTemplate        = "app"
	CommandHelpTemplate    = "command"
	SubcommandHelpTemplate = "subcommand"
)
