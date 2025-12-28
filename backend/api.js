import express from 'express';
import fs from 'fs';
import plist from 'simple-plist';
import IRestore from './irestore-wrapper.js';
import tmp from 'tmp';
import path from 'path';
import cors from 'cors';

const port = 0;
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use(function (req, res, next) {
  if (!req.body.path || !req.body.password) {
    return res.status(400).send('Missing path or password');
  }
  if (!fs.existsSync(req.body.path)) {
    return res.status(400).send('Backup path does not exist');
  }
  next();
});

const keychainItemMap = {
  cert: 'Certs',
  genp: 'General',
  inet: 'Internet',
  keys: 'Keys',
};

// Helper function to safely decode base64 strings
// Handles URL-safe base64 and padding issues
function safeBase64Decode(str) {
  if (!str) return '';
  // Replace URL-safe characters with standard base64 characters
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding if necessary
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  try {
    return atob(base64);
  } catch (e) {
    console.error('Base64 decode error for:', str, e.message);
    // Return empty string or the original if decoding fails
    return '';
  }
}

app.post('/decrypt', async (req, res) => {
  const tempDir = tmp.dirSync({ unsafeCleanup: true });

  // Dump Keychain
  const iRestore = new IRestore(req.body.path, req.body.password);
  try {
    await iRestore.dumpKeys(path.join(tempDir.name, 'keys.json'));
    await iRestore.restore('KeychainDomain', path.join(tempDir.name, 'KeychainDomain'));
  } catch (error) {
    return res.status(500).send(`irestore error: ${error}`);
  }

  // Decrypt Keychain and partial Keychain
  const keychain = await plist.readFileSync(path.join(tempDir.name, path.join('KeychainDomain', 'keychain-backup.plist')));
  const partialDecryptedKeychain = JSON.parse(fs.readFileSync(path.join(tempDir.name, 'keys.json')));

  // Create JSON payload
  const payload = {};
  for (const [key, value] of Object.entries(keychainItemMap)) {
    payload[key] = {
      total: keychain[key].length,
      items: [],
    };
    partialDecryptedKeychain[value].forEach(item => {
      const ignoredKeys = Object.keys(item).filter(key => key[0] === '_');
      ignoredKeys.forEach(ignoredKey => {
        delete item[ignoredKey];
      });
      payload[key]['items'].push(item);
    });
  }

  tempDir.removeCallback();
  res.send(payload);
});

app.post('/update', async (req, res) => {
  const tempDir = tmp.dirSync({ unsafeCleanup: true });

  // Dump Keychain
  const iRestore = new IRestore(req.body.path, req.body.password);
  try {
    await iRestore.dumpKeys(path.join(tempDir.name, 'keys.json'));
    await iRestore.restore('KeychainDomain', path.join(tempDir.name, 'KeychainDomain'));
  } catch (error) {
    return res.status(500).send(`irestore error: ${error}`);
  }
  const partialDecryptedKeychain = JSON.parse(fs.readFileSync(path.join(tempDir.name, 'keys.json')));

  // Update partial decrypted Keychain
  const updatedItems = JSON.parse(req.body.items);
  updatedItems.forEach(update => {
    Object.values(keychainItemMap).forEach(value => {
      partialDecryptedKeychain[value].forEach((item, index) => {
        if (item.persistref === update.persistref) {
          for (const [k, v] of Object.entries(update)) {
            partialDecryptedKeychain[value][index][k] = v;
          }
        }
      });
    });
  });

  fs.writeFileSync(path.join(tempDir.name, 'keys-updated.json'), JSON.stringify(partialDecryptedKeychain, null, 2));

  // Encrypt partial Keychain
  await iRestore.encryptKeys(path.join(tempDir.name, 'keys-updated.json'), path.join(tempDir.name, 'keys-updated.plist'));
  const partialKeychain = await plist.readFileSync(path.join(tempDir.name, 'keys-updated.plist'));

  // Load Keychain
  const keychain = await plist.readFileSync(path.join(tempDir.name, path.join('KeychainDomain', 'keychain-backup.plist')));

  // Update Keychain
  Object.keys(keychainItemMap).forEach(key => {
    keychain[key].forEach(item => {
      updatedItems.forEach(update => {
        const persistentRefWithType = btoa(key + safeBase64Decode(update.persistref));
        if (item.v_PersistentRef.toString('base64') === persistentRefWithType) {
          partialKeychain[key].forEach(updatedItem => {
            if (updatedItem.v_PersistentRef.toString('base64') === persistentRefWithType) {
              item.v_Data = updatedItem.v_Data;
            }
          });
        }
      });
    });
  });

  // Save Keychain
  const updatedKeychainPath = path.join(tempDir.name, path.join('KeychainDomain', 'keychain-backup.plist'));
  plist.writeBinaryFileSync(updatedKeychainPath, keychain);
  const updatedKeychainPlist = fs.readFileSync(updatedKeychainPath);
  res.setHeader('Content-Disposition', 'attachment; filename=keychain-backup.plist');
  res.send(updatedKeychainPlist);
  tempDir.removeCallback();
});

app.post('/delete', async (req, res) => {
  const tempDir = tmp.dirSync({ unsafeCleanup: true });

  // Validate delete items
  if (!req.body.items) {
    return res.status(400).send('Missing items to delete');
  }

  const deleteItems = JSON.parse(req.body.items);
  if (!Array.isArray(deleteItems) || deleteItems.length === 0) {
    return res.status(400).send('No items specified for deletion');
  }

  // Create a set of persistrefs to delete for quick lookup
  const deleteRefs = new Set(deleteItems.map(item => item.persistref));

  // Dump Keychain
  const iRestore = new IRestore(req.body.path, req.body.password);
  try {
    await iRestore.dumpKeys(path.join(tempDir.name, 'keys.json'));
    await iRestore.restore('KeychainDomain', path.join(tempDir.name, 'KeychainDomain'));
  } catch (error) {
    return res.status(500).send(`irestore error: ${error}`);
  }

  // Load the decrypted keys
  const partialDecryptedKeychain = JSON.parse(fs.readFileSync(path.join(tempDir.name, 'keys.json')));

  // Remove items from partial decrypted keychain
  Object.values(keychainItemMap).forEach(value => {
    partialDecryptedKeychain[value] = partialDecryptedKeychain[value].filter(
      item => !deleteRefs.has(item.persistref)
    );
  });

  fs.writeFileSync(path.join(tempDir.name, 'keys-updated.json'), JSON.stringify(partialDecryptedKeychain, null, 2));

  // Encrypt partial Keychain
  await iRestore.encryptKeys(path.join(tempDir.name, 'keys-updated.json'), path.join(tempDir.name, 'keys-updated.plist'));

  // Load Keychain
  const keychain = await plist.readFileSync(path.join(tempDir.name, path.join('KeychainDomain', 'keychain-backup.plist')));

  // Remove items from keychain plist
  Object.keys(keychainItemMap).forEach(key => {
    keychain[key] = keychain[key].filter(item => {
      // Check if this item should be deleted
      for (const deleteItem of deleteItems) {
        const persistentRefWithType = btoa(key + safeBase64Decode(deleteItem.persistref));
        if (item.v_PersistentRef.toString('base64') === persistentRefWithType) {
          return false; // Filter out this item
        }
      }
      return true; // Keep this item
    });
  });

  // Save Keychain
  const updatedKeychainPath = path.join(tempDir.name, path.join('KeychainDomain', 'keychain-backup.plist'));
  plist.writeBinaryFileSync(updatedKeychainPath, keychain);
  const updatedKeychainPlist = fs.readFileSync(updatedKeychainPath);
  res.setHeader('Content-Disposition', 'attachment; filename=keychain-backup.plist');
  res.send(updatedKeychainPlist);
  tempDir.removeCallback();
});

const server = app.listen(port, () => {
  fs.writeFileSync('port.ts', `export default ${server.address().port};`);
});
