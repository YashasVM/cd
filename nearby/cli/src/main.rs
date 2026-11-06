use cd_nearby_engine::{Engine, Offer, Snapshot, Transfer};
use std::env;
use std::error::Error;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

const POLL_INTERVAL: Duration = Duration::from_millis(500);

fn main() {
    if let Err(error) = run(env::args().skip(1).collect()) {
        eprintln!("nearby: {error}");
        std::process::exit(1);
    }
}

fn run(args: Vec<String>) -> Result<(), Box<dyn Error>> {
    if args.is_empty() || args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print_help();
        return Ok(());
    }

    match parse(args)? {
        Command::Send { paths, name } => send(paths, name),
        Command::Inspect { invite } => inspect(&invite),
        Command::Receive {
            invite,
            output,
            accept,
            name,
        } => receive(&invite, output, accept, name),
    }
}

enum Command {
    Send {
        paths: Vec<PathBuf>,
        name: String,
    },
    Inspect {
        invite: String,
    },
    Receive {
        invite: String,
        output: PathBuf,
        accept: bool,
        name: String,
    },
}

fn parse(args: Vec<String>) -> Result<Command, String> {
    let mut args = args.into_iter();
    let action = args.next().ok_or_else(|| "missing command".to_owned())?;
    let rest: Vec<String> = args.collect();
    match action.as_str() {
        "send" => parse_send(rest),
        "inspect" => parse_inspect(rest),
        "receive" => parse_receive(rest),
        _ => Err(format!("unknown command `{action}`\n\n{}", help_text())),
    }
}

fn parse_send(args: Vec<String>) -> Result<Command, String> {
    let mut paths = Vec::new();
    let mut name = "Nearby CLI".to_owned();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--name" => name = args.next().ok_or("--name needs a value")?,
            option if option.starts_with('-') => {
                return Err(format!("unknown send option `{option}`"))
            }
            path => paths.push(PathBuf::from(path)),
        }
    }
    if paths.is_empty() {
        return Err("send needs at least one file or folder".into());
    }
    Ok(Command::Send { paths, name })
}

fn parse_inspect(args: Vec<String>) -> Result<Command, String> {
    if args.len() != 1 {
        return Err("inspect needs exactly one invitation".into());
    }
    Ok(Command::Inspect {
        invite: args[0].clone(),
    })
}

fn parse_receive(args: Vec<String>) -> Result<Command, String> {
    let mut invite = None;
    let mut output = None;
    let mut accept = false;
    let mut name = "Nearby CLI".to_owned();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--out" => output = Some(PathBuf::from(args.next().ok_or("--out needs a directory")?)),
            "--accept" => accept = true,
            "--name" => name = args.next().ok_or("--name needs a value")?,
            option if option.starts_with('-') => {
                return Err(format!("unknown receive option `{option}`"))
            }
            value if invite.is_none() => invite = Some(value.to_owned()),
            _ => return Err("receive accepts exactly one invitation".into()),
        }
    }
    Ok(Command::Receive {
        invite: invite.ok_or("receive needs an invitation")?,
        output: output.ok_or("receive needs --out DIR")?,
        accept,
        name,
    })
}

fn new_engine(name: String) -> Result<(Engine, tempfile::TempDir), Box<dyn Error>> {
    let state_dir = tempfile::tempdir()?;
    let engine = Engine::new(name, state_dir.path().to_owned())?;
    Ok((engine, state_dir))
}

fn send(paths: Vec<PathBuf>, name: String) -> Result<(), Box<dyn Error>> {
    let (engine, _state_dir) = new_engine(name)?;
    let share = engine.share(paths)?;
    // The invitation is an access credential. Keep it on stdout only, where the
    // caller can copy or redirect it intentionally.
    println!("{}", share.invite);
    eprintln!(
        "Sharing {} ({} bytes). Waiting for receiver…",
        share.name, share.size
    );
    let result = wait_for_transfer(&engine, &share.id, "send");
    let revoke_result = engine.revoke(&share.id).map_err(|error| error.to_string());
    result?;
    revoke_result?;
    eprintln!("Transfer complete; invitation revoked.");
    Ok(())
}

fn inspect(invite: &str) -> Result<(), Box<dyn Error>> {
    let (engine, _state_dir) = new_engine("Nearby CLI".into())?;
    let offer = engine.inspect_invite(invite)?;
    print_offer(&offer)?;
    Ok(())
}

fn receive(
    invite: &str,
    output: PathBuf,
    accept: bool,
    name: String,
) -> Result<(), Box<dyn Error>> {
    let (engine, _state_dir) = new_engine(name)?;
    let offer = engine.inspect_invite(invite)?;
    print_offer(&offer)?;
    if !accept && !confirm()? {
        eprintln!("Receive cancelled.");
        return Ok(());
    }
    let id = engine.receive(invite.to_owned(), output)?;
    eprintln!("Receiving {} ({} bytes)…", offer.name, offer.size);
    wait_for_transfer(&engine, &id, "receive")?;
    let snapshot = engine.snapshot();
    let transfer =
        find_transfer(&snapshot, &id).ok_or("transfer completed but no status is available")?;
    let output_path = transfer
        .output_path
        .as_deref()
        .unwrap_or("(path unavailable)");
    println!("{output_path}");
    Ok(())
}

fn print_offer(offer: &Offer) -> Result<(), Box<dyn Error>> {
    println!("{}", serde_json::to_string_pretty(offer)?);
    Ok(())
}

fn confirm() -> Result<bool, Box<dyn Error>> {
    eprint!("Accept this transfer? [y/N] ");
    io::stderr().flush()?;
    let mut answer = String::new();
    io::stdin().lock().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}

fn wait_for_transfer(engine: &Engine, id: &str, direction: &str) -> Result<(), Box<dyn Error>> {
    let mut last_progress = None;
    loop {
        let snapshot = engine.snapshot();
        let transfer = find_transfer(&snapshot, id)
            .ok_or_else(|| format!("{direction} transfer disappeared from engine status"))?;
        match transfer.status.as_str() {
            "completed" => {
                eprintln!(
                    "{direction}: {} / {} bytes (completed)",
                    transfer.total, transfer.total
                );
                return Ok(());
            }
            "failed" => {
                return Err(transfer
                    .error
                    .clone()
                    .unwrap_or_else(|| format!("{direction} transfer failed"))
                    .into())
            }
            "waiting" | "transferring" | "paused" => {
                let progress = (transfer.bytes, transfer.total, transfer.status.clone());
                if last_progress.as_ref() != Some(&progress) {
                    eprintln!(
                        "{}: {} / {} bytes ({})",
                        direction, transfer.bytes, transfer.total, transfer.status
                    );
                    last_progress = Some(progress);
                }
            }
            status => return Err(format!("unexpected transfer status `{status}`").into()),
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn find_transfer<'a>(snapshot: &'a Snapshot, id: &str) -> Option<&'a Transfer> {
    snapshot.transfers.iter().find(|transfer| transfer.id == id)
}

fn print_help() {
    println!("{}", help_text());
}

fn help_text() -> &'static str {
    "Usage:\n  nearby send <paths...> [--name NAME]\n  nearby inspect <invite>\n  nearby receive <invite> --out DIR [--accept] [--name NAME]\n  nearby --help\n\nCommands:\n  send     Share files or folders and print the invitation to stdout.\n  inspect  Print the offer described by an invitation as JSON.\n  receive  Show an offer, ask before receiving, then print the output path.\n\nUse --accept only when you intend to accept without an interactive prompt."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_send_paths_and_name() {
        let parsed = parse(vec![
            "send".into(),
            "one file.txt".into(),
            "folder".into(),
            "--name".into(),
            "Laptop".into(),
        ])
        .unwrap();
        match parsed {
            Command::Send { paths, name } => {
                assert_eq!(
                    paths,
                    vec![PathBuf::from("one file.txt"), PathBuf::from("folder")]
                );
                assert_eq!(name, "Laptop");
            }
            _ => panic!("expected send command"),
        }
    }

    #[test]
    fn parses_receive_requires_destination_and_defaults_to_prompt() {
        let parsed = parse(vec![
            "receive".into(),
            "nearby:invite".into(),
            "--out".into(),
            "downloads".into(),
        ])
        .unwrap();
        match parsed {
            Command::Receive { accept, output, .. } => {
                assert!(!accept);
                assert_eq!(output, PathBuf::from("downloads"));
            }
            _ => panic!("expected receive command"),
        }
        assert!(parse(vec!["receive".into(), "nearby:invite".into()]).is_err());
    }

    #[test]
    fn rejects_unknown_commands_and_extra_invites() {
        assert!(parse(vec!["remove".into()]).is_err());
        assert!(parse(vec!["inspect".into(), "one".into(), "two".into()]).is_err());
        assert!(parse(vec![
            "receive".into(),
            "one".into(),
            "two".into(),
            "--out".into(),
            "dir".into()
        ])
        .is_err());
    }

    #[test]
    fn help_describes_all_commands_and_accept_opt_in() {
        let help = help_text();
        assert!(help.contains("nearby send"));
        assert!(help.contains("nearby inspect"));
        assert!(help.contains("nearby receive"));
        assert!(help.contains("--accept"));
    }
}
