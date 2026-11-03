# Setup and deployment guide

How to run the Seaport Global platform on a new laptop, and how to deploy it on AWS.

**Contents**

1. [What you are installing](#1-what-you-are-installing)
2. [Set up on a new laptop (Windows)](#2-set-up-on-a-new-laptop-windows)
3. [Set up on macOS or Linux](#3-set-up-on-macos-or-linux)
4. [Day-to-day commands](#4-day-to-day-commands)
5. [Settings (environment variables)](#5-settings-environment-variables)
6. [Changing the code and pushing to GitHub](#6-changing-the-code-and-pushing-to-github)
7. [Troubleshooting](#7-troubleshooting)
8. [Deploy on AWS: single EC2 server (recommended now)](#8-deploy-on-aws-single-ec2-server-recommended-now)
9. [Deploy on AWS with Docker](#9-deploy-on-aws-with-docker)
10. [Target production architecture on AWS](#10-target-production-architecture-on-aws)
11. [Security checklist before real users or client data](#11-security-checklist-before-real-users-or-client-data)

---

## 1. What you are installing

| Part | Technology | Folder |
|---|---|---|
| Web screens | React 19, pre-built into `public/` | `web/src` |
| API, database, ledger, workflow | Node.js 22.18+ (TypeScript run directly, built-in SQLite) | `src/` |
| Pricing, file parsing, PDFs, payment files | Python 3.10+ (standard library only) | `engine/` |

**No `npm install` or `pip install` is needed to run the app.** You need only Node.js and Python.
`npm start` launches the Python engine automatically, then serves the screens and the API on one port (3000).

Data is stored in `data/`:

* `data/seaport.db` holds the SQLite database.
* `data/files/` holds uploaded and generated documents.

The `data/` folder is **not** in Git. Each machine has its own data, and the first start loads demo data.

---

## 2. Set up on a new laptop (Windows)

### 2.1 Install the prerequisites (one time)

1. **Node.js 22.18 or newer**: https://nodejs.org → download the **LTS** Windows installer (`.msi`) and accept the defaults.
2. **Python 3.10 or newer**: https://www.python.org/downloads/ → run the installer and **tick "Add python.exe to PATH"** on the first screen.
3. **Git**: https://git-scm.com/download/win → accept the defaults.

Open a **new** PowerShell window and check:

```powershell
node -v          # v22.18.0 or higher
python --version # Python 3.10 or higher
git --version
```

### 2.2 Get the code

The repository is private, so sign in to GitHub as an account that has access.

```powershell
cd $HOME\Documents
git clone https://github.com/tradingbotxyz-wq/seaport-platform.git
cd seaport-platform
```

The first `git clone` opens a browser window to sign in to GitHub (Git Credential Manager). Approve it.

*No Git?* On the repository page, click **Code → Download ZIP**, then extract it to `Documents\seaport-platform`.

### 2.3 Run it

Either double-click **`start.bat`** in the folder, or run:

```powershell
cd $HOME\Documents\seaport-platform
npm.cmd start
```

Open **http://localhost:3000**. The first start creates `data\seaport.db` and loads demo data, with dates positioned around today. Press **Ctrl+C** in the window to stop.

> Use `npm.cmd`, not `npm`, if PowerShell says *"running scripts is disabled on this system"* (see [Troubleshooting](#7-troubleshooting)).

### 2.4 Check it works (optional)

```powershell
npm.cmd test              # 15 end-to-end API tests (starts its own engine and in-memory database)
npm.cmd run test:engine   # Python engine unit tests
```

### 2.5 Sign in

Pick a demo user on the sign-in screen. For example:

* **Priya Nair** (operations checker) approves funding.
* **Rabuan** (operations maker) uploads files.
* **Lucas Moreau** (trader) uses Brokerage.
* **Pemberton** (investor) sees the investor portal only.

The full list is in the README.

---

## 3. Set up on macOS or Linux

```bash
# macOS (Homebrew)
brew install node@22 python@3.12 git
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 git

git clone https://github.com/tradingbotxyz-wq/seaport-platform.git
cd seaport-platform
npm start          # then open http://localhost:3000
```

If `python3` is not found, tell the app where Python is: `PYTHON=/path/to/python3 npm start`.

---

## 4. Day-to-day commands

Run these from the project folder. On Windows, use `npm.cmd`.

| Command | What it does |
|---|---|
| `npm start` | Start the engine + API + screens on http://localhost:3000 |
| `npm run reset` | **Delete** the database and documents, then reload fresh demo data |
| `npm run seed` | Load demo data into an empty database |
| `npm test` | End-to-end API tests |
| `npm run test:engine` | Python unit tests |
| `npm run build:web` | Rebuild the screens after editing `web/src` (needs the one-time step in §6) |
| `git pull` | Get the latest code (stop the app first; database upgrades run automatically on the next start) |

**Back up your local data:** stop the app, then copy the `data` folder somewhere safe.

---

## 5. Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web/API port |
| `HOST` | `127.0.0.1` | Network interface. Use `0.0.0.0` only inside Docker or behind a proxy |
| `ENGINE_PORT` | `8001` | Port of the Python engine (local only) |
| `ENGINE_URL` | (none) | Use an engine that is already running instead of starting one |
| `PYTHON` | auto (`py -3`, `python`, `python3`) | Path to the Python executable |
| `DB_PATH` | `data/seaport.db` | SQLite database file |
| `FILES_DIR` | `data/files` | Uploaded and generated documents |
| `BUSINESS_DATE` | today (local time) | Override "today", e.g. `2026-09-21`, for testing |
| `TZ` | system | Time zone that defines the business date (e.g. `America/New_York`) |

PowerShell example: `$env:PORT=4000; npm.cmd start`

---

## 6. Changing the code and pushing to GitHub

* **API / Python changes** (`src/`, `engine/`) take effect on the next `npm start`.
* **Screen changes** (`web/src`) must be rebuilt:

  ```powershell
  cd web
  npm.cmd install    # one time: installs React + esbuild into web\node_modules
  cd ..
  npm.cmd run build:web     # or: npm.cmd run dev:web  (rebuilds on every save)
  ```

  Commit the rebuilt `public/app.js` and `public/app.css` too. Servers run the pre-built files and never build anything.

* Save your work to GitHub:

  ```powershell
  git checkout -b my-change
  git add -A
  git commit -m "Describe the change"
  git push -u origin my-change     # then open a pull request on GitHub
  ```

Run `npm test` before pushing.

---

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| `npm.ps1 cannot be loaded because running scripts is disabled` | Use `npm.cmd start`, or run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |
| `python` opens the Microsoft Store / "Python was not found" | Reinstall Python with **Add to PATH** ticked, or turn off *Settings → Apps → Advanced app settings → App execution aliases → python.exe*. Or set `$env:PYTHON="C:\Path\to\python.exe"` |
| `Could not start the Python engine` | As above. Python 3.10+ is required |
| `EADDRINUSE` / port already in use | Another copy is running. Close it, or use `$env:PORT=3001` |
| `node:sqlite` or `.ts` errors at start | Node is older than 22.18. Upgrade Node |
| Screens look old after `git pull` | Hard-refresh the browser (Ctrl+F5) |
| Want a clean start | Stop the app, then run `npm.cmd run reset` (this deletes your local data) |

---

## 8. Deploy on AWS: single EC2 server (recommended now)

The app keeps its data in SQLite on local disk, so today it runs as **one server**: an EC2 instance with an EBS disk, with nginx in front.
This is the right fit for a pilot, UAT or internal demo.
For multi-server, high-availability production, see §10.

```
Users ──HTTPS──► nginx (EC2, port 443/80, password gate) ──► Node app :3000 ──► Python engine :8001
                                   │                                 └── /var/lib/seaport (EBS): seaport.db + files
                                   └── nightly backup ──► S3
```

### 8.1 Create the server (AWS console)

1. **EC2 → Launch instance**
   * Name: `seaport-app`
   * AMI: **Ubuntu Server 24.04 LTS** (64-bit, x86 or Arm)
   * Instance type: **t3.small** (2 GB) for demo/UAT; **t3.medium** for a team pilot
   * Key pair: create one and keep the `.pem` file safe
   * Storage: **30 GB gp3**, encrypted
   * Security group: **SSH (22) from *My IP* only**, **HTTP (80) and HTTPS (443) from your office/VPN IP range only**. Do not open the app to `0.0.0.0/0` (see §11).
2. **Elastic IP:** allocate one and associate it with the instance, so the address survives restarts.
3. (Optional) **DNS:** in Route 53 or your DNS provider, create `seaport.yourcompany.com` → the Elastic IP.
4. (For backups) **S3:** create a private bucket, e.g. `seaport-backups-<account-id>`, with versioning and default encryption.
   Create an **IAM role** for EC2 with `s3:PutObject`/`s3:ListBucket` on that bucket, and attach it to the instance (*Actions → Security → Modify IAM role*).

### 8.2 Give the server read access to the private repository

On the server, create a deploy key (read-only):

```bash
ssh -i seaport-key.pem ubuntu@<elastic-ip>
ssh-keygen -t ed25519 -C "seaport-ec2" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

On GitHub, open the repository and go to **Settings → Deploy keys → Add deploy key**. Paste the key, leave **write access unticked**, and save.

### 8.3 Install

```bash
git clone git@github.com:tradingbotxyz-wq/seaport-platform.git ~/seaport-platform
cd ~/seaport-platform
sudo bash deploy/aws-ec2/install.sh
```

The script:

* installs Node.js 22, Python 3, nginx and the AWS CLI;
* creates the `seaport` service user and `/var/lib/seaport` (database + documents);
* copies the app to `/opt/seaport-platform`;
* installs the **systemd** service (auto-start on boot, restart on failure);
* configures **nginx** with a password gate. It asks you to set the password for user `seaport`.

Open `http://<elastic-ip>/`, enter the gate password, and pick a user. The first start loads demo data.
To start with an empty system instead, run `sudo systemctl stop seaport`, then load your own users and programs (see §11).

### 8.4 HTTPS

With a domain pointing at the server:

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d seaport.yourcompany.com     # auto-renews
```

*Alternative:* put an **Application Load Balancer** in front, with an **ACM** certificate, health check path `/api/health`, and the EC2 security group allowing port 80 only from the ALB.

### 8.5 Deploy new versions

After code is pushed to `main`:

```bash
cd ~/seaport-platform
sudo bash deploy/aws-ec2/update.sh
```

This takes a backup, runs `git pull`, copies the code to `/opt`, restarts the service (database migrations run automatically) and checks `/api/health`.

### 8.6 Backups

```bash
# one-off
sudo BACKUP_BUCKET=seaport-backups-<account-id> bash ~/seaport-platform/deploy/aws-ec2/backup.sh
# nightly at 01:30: sudo crontab -e, then add:
30 1 * * * BACKUP_BUCKET=seaport-backups-<account-id> bash /home/ubuntu/seaport-platform/deploy/aws-ec2/backup.sh >> /var/log/seaport-backup.log 2>&1
```

The backup uses SQLite's online-backup API, so it is safe while the app runs. It checks integrity, keeps 14 local copies and copies them to S3.
Also enable **AWS Backup** or daily **EBS snapshots** of the volume.

**Restore:**

```bash
sudo systemctl stop seaport
sudo cp <backup>/seaport.db /var/lib/seaport/seaport.db
sudo rm -f /var/lib/seaport/seaport.db-wal /var/lib/seaport/seaport.db-shm
sudo tar -xzf <backup>/files.tar.gz -C /var/lib/seaport
sudo chown -R seaport:seaport /var/lib/seaport
sudo systemctl start seaport
```

### 8.7 Operate

| Task | Command |
|---|---|
| Status | `sudo systemctl status seaport` |
| Logs (live) | `sudo journalctl -u seaport -f` |
| Restart | `sudo systemctl restart seaport` |
| Health | `curl http://127.0.0.1:3000/api/health` |
| Change gate password | `sudo htpasswd /etc/nginx/seaport.htpasswd seaport` |

Optional: install the CloudWatch agent to ship `journalctl` logs, and add a CloudWatch alarm on instance status checks.

---

## 9. Deploy on AWS with Docker

A `Dockerfile` is included. It packages Node, Python and the app in one image. Data lives in `/data`, so **always mount a volume there**.

```bash
docker build -t seaport-platform .
docker run -d --name seaport --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -v seaport-data:/data \
  -e TZ=America/New_York seaport-platform
```

On EC2, install Docker (`sudo apt-get install -y docker.io`), run the commands above, and keep nginx (§8.3–8.4) in front for HTTPS and the password gate.
To use **Amazon ECR**:

1. Create a repository.
2. Run `aws ecr get-login-password | docker login …`.
3. `docker tag` and `docker push`, then pull on the server.

**ECS Fargate:** only once the app runs on PostgreSQL (§10). SQLite needs a single writer on a local disk. Running it on EFS, or on more than one task, risks database corruption.

---

## 10. Target production architecture on AWS

This is the architecture in the proposal. Moving to it is planned under *Module 8 – Production readiness*, which adds the PostgreSQL adapter, Terraform and CI/CD.

| Concern | Today (pilot) | Production target |
|---|---|---|
| Compute | 1 × EC2 (systemd) | **ECS Fargate**: API service (2+ tasks, multi-AZ) and Python engine service, behind an **ALB** with **AWS WAF** |
| Database | SQLite on EBS | **Aurora PostgreSQL** (Multi-AZ, encrypted, PITR backups). Only `src/lib/db.ts` and the SQL dialect change |
| Documents | `/var/lib/seaport/files` | **S3** (SSE-KMS, versioning, Object Lock for audit evidence) |
| Sign-in | Demo user picker + nginx password | **Amazon Cognito** or **Entra ID SSO**, with MFA. Roles map to the existing permission model |
| Notifications | In-app outbox | **SES** e-mail / **SNS**, with **EventBridge** for integration events |
| Secrets | Environment variables | **Secrets Manager** / SSM Parameter Store |
| Monitoring | journald | **CloudWatch** logs, metrics and alarms; **CloudTrail**; **GuardDuty** |
| Delivery | `update.sh` | **GitHub Actions** → test → build image → **ECR** → ECS rolling deploy; **Terraform** for all infrastructure |
| Network | Public EC2 + security group | **VPC** with private subnets for app/DB, NAT, VPC endpoints for S3/ECR |

---

## 11. Security checklist before real users or client data

The current build is an MVP for demonstration and UAT. **Before any real client data:**

- [ ] **Real sign-in.** The user picker trusts the browser (`X-User` header), so anyone who reaches the app can act as any user. Until Module 7 (password + MFA / SSO) is deployed, keep the nginx password gate on **and** limit the security group to known IPs or VPN.
- [ ] HTTPS only (certbot or ALB + ACM).
- [ ] Remove the demo data: start from an empty database and create the real users, programs and obligors.
- [ ] Encrypted EBS volume and S3 backup bucket (both are on if you followed §8.1).
- [ ] Nightly backups verified with a test restore.
- [ ] OS patching: `sudo apt-get update && sudo apt-get upgrade` monthly, or enable `unattended-upgrades`.
- [ ] Replace the mock KYC/AML, credit bureau and market-data adapters (`src/integrations/screening.ts`, `engine/brokerage.py`) with the real providers.
- [ ] Penetration test and UAT sign-off.
