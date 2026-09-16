//! Line-oriented fixture IPC. Never connect this process to production data.
use larynx_security_spike::fixture::{FixturePeer, MAX_FRAME_BYTES};
use std::io::{self, BufRead, Read, Write};
const MAX_LINE_BYTES: usize = MAX_FRAME_BYTES * 2 + 32;

fn decode(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() > MAX_FRAME_BYTES * 2 || !hex.len().is_multiple_of(2) {
        return Err("invalid_hex".into());
    }
    hex.as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            fn digit(byte: u8) -> Option<u8> {
                match byte {
                    b'0'..=b'9' => Some(byte - b'0'),
                    b'a'..=b'f' => Some(byte - b'a' + 10),
                    _ => None,
                }
            }
            match (digit(pair[0]), digit(pair[1])) {
                (Some(a), Some(b)) => Ok(a * 16 + b),
                _ => Err("invalid_hex".into()),
            }
        })
        .collect()
}

fn encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}

fn command(peer: &mut FixturePeer, line: &str) -> Result<String, String> {
    let (name, argument) = line.split_once(' ').unwrap_or((line, ""));
    let takes_bytes = matches!(
        name,
        "add_member" | "join" | "send" | "receive" | "apply_commit"
    );
    if !takes_bytes && !argument.is_empty() {
        return Err("unexpected_argument".into());
    }
    let bytes = if takes_bytes {
        decode(argument)?
    } else {
        Vec::new()
    };
    match name {
        "key_package" => peer.key_package().map(|b| encode(&b)),
        "create_group" => peer.create_group().map(|_| String::new()),
        "add_member" => peer.add_member(&bytes).map(|b| encode(&b)),
        "join" => peer.join(&bytes).map(|_| String::new()),
        "send" => peer.send(&bytes).map(|b| encode(&b)),
        "receive" => peer.receive(&bytes).map(|b| encode(&b)),
        "remove_peer" => peer.remove_peer().map(|b| encode(&b)),
        "apply_commit" => peer.apply_commit(&bytes).map(|_| String::new()),
        "authenticator" => peer.authenticator().map(|b| encode(&b)),
        "active" => Ok(peer.active().to_string()),
        _ => Err("unknown_command".into()),
    }
}

fn run(mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let mut peer = FixturePeer::new("native")
        .map_err(|_| io::Error::other("fixture initialization failed"))?;
    // Bound all commands, including parsing failures/read-only requests.
    for _ in 0..256 {
        let mut line = Vec::new();
        // take() caps allocation even when the input never supplies a newline.
        let read = input
            .by_ref()
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)?;
        if read == 0 {
            return Ok(());
        }
        if line.len() > MAX_LINE_BYTES || !line.ends_with(b"\n") {
            writeln!(output, "ERR invalid_line_size")?;
            output.flush()?;
            return Ok(());
        }
        line.pop();
        let result = std::str::from_utf8(&line)
            .map_err(|_| "invalid_command".to_string())
            .and_then(|line| command(&mut peer, line));
        match result {
            Ok(value) => writeln!(output, "OK {value}")?,
            Err(code) => writeln!(output, "ERR {code}")?,
        }
        output.flush()?;
    }
    writeln!(output, "ERR operation_limit")?;
    output.flush()
}

fn main() {
    if run(io::stdin().lock(), io::stdout().lock()).is_err() {
        eprintln!("fixture_io_failed");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_hex_and_command_validation() {
        assert_eq!(decode("00ff").unwrap(), [0, 255]);
        assert!(decode("0").is_err());
        assert!(decode("zz").is_err());
        assert!(decode(&"00".repeat(MAX_FRAME_BYTES + 1)).is_err());
        let mut peer = FixturePeer::new("cli").unwrap();
        assert_eq!(command(&mut peer, "bogus").unwrap_err(), "unknown_command");
        assert_eq!(
            command(&mut peer, "active value").unwrap_err(),
            "unexpected_argument"
        );
        assert_eq!(command(&mut peer, "receive zz").unwrap_err(), "invalid_hex");
        assert_eq!(command(&mut peer, "active").unwrap(), "false");
    }
    #[test]
    fn ipc_input_bounds_and_error_recovery() {
        let mut output = Vec::new();
        run(io::Cursor::new(b"receive zz\nactive\n"), &mut output).unwrap();
        assert_eq!(output, b"ERR invalid_hex\nOK false\n");
        for input in [vec![b'a'; MAX_LINE_BYTES + 1], b"active".to_vec()] {
            output.clear();
            run(io::Cursor::new(input), &mut output).unwrap();
            assert_eq!(output, b"ERR invalid_line_size\n");
        }
        output.clear();
        run(io::Cursor::new("active\n".repeat(257)), &mut output).unwrap();
        assert_eq!(
            String::from_utf8(output).unwrap(),
            format!("{}ERR operation_limit\n", "OK false\n".repeat(256))
        );
    }
}
