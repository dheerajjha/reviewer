# Security policy

## Reporting a vulnerability

Please report it privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue for it.

You'll hear back within a few days. The fix ships in a new release, and the advisory credits you unless you'd rather it didn't.

## Supported versions

Security fixes go into the latest release only.

## Scope

reviewer runs a local web server bound to 127.0.0.1 unless you set `HOST`. The failures worth reporting are anything that lets a web page, another user on the machine, or a file in the reviewed repository read or change files outside that repository, or run a command.
