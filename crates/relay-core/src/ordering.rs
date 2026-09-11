use crate::Result;
use std::io::{self, Read};

pub fn run(operation: &str, args: &[String]) -> Result<()> {
    match (operation, args.split_first()) {
        ("prompt-reorder", Some((raw, accounts))) => {
            let raw = raw.trim();
            if raw.is_empty() {
                println!("{}", accounts.join(","));
                return Ok(());
            }
            let tokens: Vec<String> =
                if accounts.len() <= 9 && raw.bytes().all(|b| b.is_ascii_digit()) {
                    raw.chars().map(|c| c.to_string()).collect()
                } else {
                    raw.split(|c: char| c.is_whitespace() || c == ',')
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .collect()
                };
            let mut selected = Vec::new();
            for token in tokens {
                if token.bytes().all(|b| b.is_ascii_digit()) {
                    if let Ok(index) = token.parse::<usize>() {
                        if let Some(account) = index.checked_sub(1).and_then(|i| accounts.get(i)) {
                            selected.push(account.clone());
                        }
                    }
                } else {
                    selected.push(token);
                }
            }
            println!("{}", selected.join(","));
        }
        ("reorder-chain", None) => {
            let mut text = String::new();
            io::stdin()
                .read_to_string(&mut text)
                .map_err(|_| "cannot read account order")?;
            println!(
                "{} -> (cycle)",
                text.trim().split(',').collect::<Vec<_>>().join(" -> ")
            );
        }
        _ => return Err("invalid operation arguments"),
    }
    Ok(())
}
