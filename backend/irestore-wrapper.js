/**
 * Custom iRestore wrapper that uses `expect` instead of node-pty
 * to handle password-protected iOS backups on macOS Tahoe (26.x)
 * where node-pty's posix_spawnp fails due to sandboxing issues.
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class IRestoreWrapper {
    constructor(backupPath, password = null) {
        this.backupPath = backupPath;
        this.password = password;
    }

    _findIRestoreBin() {
        // Check local node_modules first
        let bin = path.join(__dirname, '..', 'node_modules', 'irestore', 'bin', 'irestore');
        if (fs.existsSync(bin)) {
            return bin;
        }

        // Check npm global prefix
        try {
            const npmGlobalPrefix = execSync('npm prefix -g').toString().trim();
            bin = path.join(npmGlobalPrefix, 'bin', 'irestore');
            if (fs.existsSync(bin)) {
                return bin;
            }
        } catch (e) {
            // Ignore
        }

        // Fall back to PATH
        return 'irestore';
    }

    _runWithExpect(bin, args) {
        return new Promise((resolve, reject) => {
            const command = [bin, ...args].map(arg => `"${arg}"`).join(' ');

            // Create expect script to handle password prompt
            const expectScript = `
        set timeout 120
        spawn ${command}
        expect {
          "Backup Password: " {
            send "${this.password.replace(/"/g, '\\"')}\\r"
            exp_continue
          }
          "Bad password" {
            exit 1
          }
          "irestore done." {
            exit 0
          }
          eof {
            exit 0
          }
          timeout {
            exit 2
          }
        }
      `;

            const child = spawn('expect', ['-c', expectScript], {
                stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env,
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                if (code === 1) {
                    reject(new Error('Bad password.'));
                } else if (code === 2) {
                    reject(new Error('Timeout waiting for irestore.'));
                } else if (code !== 0) {
                    reject(new Error(`irestore failed with code ${code}: ${stderr || stdout}`));
                } else {
                    resolve(stdout);
                }
            });

            child.on('error', (err) => {
                reject(err);
            });
        });
    }

    _runWithoutPassword(bin, args) {
        return new Promise((resolve, reject) => {
            const child = spawn(bin, args, {
                stdio: ['inherit', 'pipe', 'pipe'],
                env: process.env,
            });

            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`irestore failed with code ${code}: ${stderr || stdout}`));
                } else {
                    resolve(stdout);
                }
            });

            child.on('error', (err) => {
                reject(err);
            });
        });
    }

    async runCommand(args) {
        const bin = this._findIRestoreBin();

        if (this.password) {
            return this._runWithExpect(bin, args);
        } else {
            return this._runWithoutPassword(bin, args);
        }
    }

    ls(domain) {
        return this.runCommand([this.backupPath, 'ls', domain]);
    }

    restore(domain, destPath) {
        return this.runCommand([this.backupPath, 'restore', domain, destPath]);
    }

    dumpKeys(outputFile) {
        return this.runCommand([this.backupPath, 'dumpkeys', outputFile]);
    }

    encryptKeys(inputFile, outputFile) {
        return this.runCommand([this.backupPath, 'encryptkeys', inputFile, outputFile]);
    }

    apps() {
        return this.runCommand([this.backupPath, 'apps']);
    }
}

export default IRestoreWrapper;
