package cli

import (
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/smtp"
	"os"
	"path"
	"strconv"
	"strings"

	"cdx/internal/cli"
	"cdx/src/utils"
	log "github.com/schollz/logger"
)

// MailAccount holds the SMTP credentials used by the --mail feature.
type MailAccount struct {
	SMTPHost string `json:"smtp_host"`
	SMTPPort int    `json:"smtp_port"`
	Username string `json:"username"`
	Password string `json:"password"`
	From     string `json:"from"`
}

func getMailConfigFile(requireValidPath bool) string {
	configFile, err := utils.GetConfigDir(requireValidPath)
	if err != nil {
		log.Error(err)
		return ""
	}
	return path.Join(configFile, "login.json")
}

// LoadMailAccount reads the stored SMTP credentials, if any.
func LoadMailAccount() (*MailAccount, error) {
	b, err := os.ReadFile(getMailConfigFile(false))
	if err != nil {
		return nil, err
	}
	var account MailAccount
	if err = json.Unmarshal(b, &account); err != nil {
		return nil, err
	}
	return &account, nil
}

func saveMailAccount(account *MailAccount) error {
	b, err := json.MarshalIndent(account, "", "    ")
	if err != nil {
		return err
	}
	return writePrivateConfigFile(getMailConfigFile(true), b)
}

// SendShareEmail delivers share instructions for a transfer to the supplied
// recipient using the logged-in SMTP account. Port 465 uses implicit TLS;
// other ports use STARTTLS when the server advertises it.
func SendShareEmail(account *MailAccount, to, subject, body string) (err error) {
	if account == nil || account.SMTPHost == "" {
		return errors.New("not logged in: run 'cdx login' first")
	}
	from := account.From
	if from == "" {
		from = account.Username
	}
	addr := net.JoinHostPort(account.SMTPHost, strconv.Itoa(account.SMTPPort))
	msg := strings.Join([]string{
		fmt.Sprintf("From: %s", from),
		fmt.Sprintf("To: %s", to),
		fmt.Sprintf("Subject: %s", subject),
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"",
		body,
	}, "\r\n")

	if account.SMTPPort == 465 {
		conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: account.SMTPHost})
		if err != nil {
			return fmt.Errorf("could not reach SMTP server %s: %w", addr, err)
		}
		defer conn.Close()
		return deliverMail(account, conn, from, to, msg)
	}
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		return fmt.Errorf("could not reach SMTP server %s: %w", addr, err)
	}
	defer conn.Close()
	client, err := smtp.NewClient(conn, account.SMTPHost)
	if err != nil {
		return fmt.Errorf("could not talk to SMTP server %s: %w", addr, err)
	}
	defer client.Close()
	if ok, _ := client.Extension("STARTTLS"); ok {
		if err = client.StartTLS(&tls.Config{ServerName: account.SMTPHost}); err != nil {
			return fmt.Errorf("could not start TLS with %s: %w", addr, err)
		}
	} else {
		log.Warnf("SMTP server %s does not support STARTTLS; credentials may be sent in plaintext", addr)
	}
	return sendWithClient(account, client, from, to, msg)
}

func deliverMail(account *MailAccount, conn net.Conn, from string, to string, msg string) (err error) {
	client, err := smtp.NewClient(conn, account.SMTPHost)
	if err != nil {
		return fmt.Errorf("could not talk to SMTP server: %w", err)
	}
	defer client.Close()
	return sendWithClient(account, client, from, to, msg)
}

func sendWithClient(account *MailAccount, client *smtp.Client, from string, to string, msg string) (err error) {
	if err = client.Auth(smtpAuth(account)); err != nil {
		return fmt.Errorf("SMTP authentication failed for %s: %w", account.Username, err)
	}
	fromAddr := from
	if err = client.Mail(fromAddr); err != nil {
		return fmt.Errorf("SMTP rejected sender %s: %w", fromAddr, err)
	}
	if err = client.Rcpt(to); err != nil {
		return fmt.Errorf("SMTP rejected recipient %s: %w", to, err)
	}
	w, err := client.Data()
	if err != nil {
		return err
	}
	if _, err = w.Write([]byte(msg)); err != nil {
		return err
	}
	if err = w.Close(); err != nil {
		return err
	}
	return client.Quit()
}

func smtpAuth(account *MailAccount) smtp.Auth {
	return smtp.PlainAuth("", account.Username, account.Password, account.SMTPHost)
}

// login implements `cdx login`: it saves (or clears) the SMTP account used
// by `cdx send --mail`.
func login(c *cli.Context) (err error) {
	if c.Bool("logout") {
		if removeErr := os.Remove(getMailConfigFile(false)); removeErr != nil && !os.IsNotExist(removeErr) {
			return removeErr
		}
		fmt.Println("Logged out: saved mail credentials removed.")
		return nil
	}

	if c.Bool("status") {
		account, loadErr := LoadMailAccount()
		if loadErr != nil || account.SMTPHost == "" {
			fmt.Println("Not logged in. Run 'cdx login' to save mail credentials.")
			return nil
		}
		fmt.Printf("Logged in as %s via %s:%d\n", account.Username, account.SMTPHost, account.SMTPPort)
		return nil
	}

	account, _ := LoadMailAccount()
	if account == nil {
		account = &MailAccount{}
	}
	host := c.String("smtp-host")
	if host == "" {
		if account.SMTPHost != "" {
			fmt.Printf("SMTP host [%s]: \n", account.SMTPHost)
		}
		if host, err = utils.GetInput(""); err != nil {
			return
		}
		if strings.TrimSpace(host) == "" {
			host = account.SMTPHost
		}
	}
	port := c.Int("smtp-port")
	user := c.String("user")
	if user == "" {
		if user, err = utils.GetInput("SMTP username: "); err != nil {
			return
		}
	}
	pass := c.String("pass")
	if pass == "" {
		if pass, err = utils.GetInput("SMTP password: "); err != nil {
			return
		}
	}
	from := c.String("from")
	if from == "" {
		from = user
	}
	if host == "" || user == "" || pass == "" {
		return errors.New("SMTP host, username, and password are required")
	}
	account.SMTPHost = strings.TrimSpace(host)
	account.SMTPPort = port
	account.Username = strings.TrimSpace(user)
	account.Password = pass
	account.From = strings.TrimSpace(from)
	if err = saveMailAccount(account); err != nil {
		return fmt.Errorf("could not save credentials: %w", err)
	}
	fmt.Printf("Logged in as %s via %s:%d. Use 'cdx send --mail <address>' to share by email.\n",
		account.Username, account.SMTPHost, account.SMTPPort)
	return nil
}

// emailShareCode sends the transfer share instructions with the logged-in
// mail account, if --mail was supplied.
func emailShareCode(c *cli.Context, sharedSecret string) error {
	mailTo := c.String("mail")
	if mailTo == "" {
		return nil
	}
	account, err := LoadMailAccount()
	if err != nil || account.SMTPHost == "" {
		return errors.New("--mail requires a mail account: run 'cdx login' first")
	}
	body := strings.Join([]string{
		"You have been sent files with CD.",
		"",
		"To receive them, get CD and run:",
		"",
		fmt.Sprintf("  cdx %s", sharedSecret),
		"",
		"The sender must keep their session running until the transfer finishes.",
		"Files are end-to-end encrypted; only someone with this code can receive them.",
	}, "\n")
	subject := "CD file transfer is waiting for you"
	if err := SendShareEmail(account, strings.TrimSpace(mailTo), subject, body); err != nil {
		return fmt.Errorf("could not send share email: %w", err)
	}
	fmt.Printf("Share code sent to %s\n", mailTo)
	return nil
}
