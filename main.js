const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');
const bcrypt = require('bcryptjs');

let mainWindow;
let db;
const userDataPath = app.getPath('userData');
const dbPath = path.join(userDataPath, 'database.db');
const imagesDir = path.join(userDataPath, 'product-images');

function initializeDatabase() {
    if (!fs.existsSync(imagesDir)) {
        fs.mkdirSync(imagesDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON'); 
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT,
            address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            full_name TEXT,
            username TEXT,
            password_hash TEXT,
            role TEXT DEFAULT 'admin',
            is_blocked INTEGER DEFAULT 0,
            FOREIGN KEY (company_id) REFERENCES companies(id)
        );

        CREATE TABLE IF NOT EXISTS settings (
            company_id INTEGER PRIMARY KEY,
            safe_balance REAL DEFAULT 0,
            tax_rate REAL DEFAULT 0,
            service_rate REAL DEFAULT 0,
            receipt_header TEXT,
            receipt_footer TEXT,
            FOREIGN KEY (company_id) REFERENCES companies(id)
        );

        CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT NOT NULL,
            FOREIGN KEY (company_id) REFERENCES companies(id)
        );

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            category_id INTEGER,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            image_path TEXT,
            is_available INTEGER DEFAULT 1,
            FOREIGN KEY (company_id) REFERENCES companies(id),
            FOREIGN KEY (category_id) REFERENCES categories(id)
        );

        CREATE TABLE IF NOT EXISTS inventory_materials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            name TEXT NOT NULL,
            unit TEXT,
            quantity REAL DEFAULT 0,
            min_limit REAL DEFAULT 5,
            FOREIGN KEY (company_id) REFERENCES companies(id)
        );

        CREATE TABLE IF NOT EXISTS product_ingredients (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER,
            material_id INTEGER,
            cost_per_unit REAL DEFAULT 0,
            required_qty REAL NOT NULL,
            FOREIGN KEY (product_id) REFERENCES products(id),
            FOREIGN KEY (material_id) REFERENCES inventory_materials(id)
        );

        CREATE TABLE IF NOT EXISTS inventory_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            material_id INTEGER,
            type TEXT, -- 'in' (توريد) , 'out' (صرف)
            quantity REAL NOT NULL,
            price_per_unit REAL DEFAULT 0,
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (company_id) REFERENCES companies(id),
            FOREIGN KEY (material_id) REFERENCES inventory_materials(id)
        );

        CREATE TABLE IF NOT EXISTS shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            user_id INTEGER,
            start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
            end_time DATETIME,
            initial_balance REAL DEFAULT 0,
            end_balance REAL,
            status TEXT DEFAULT 'open', -- 'open', 'closed'
            FOREIGN KEY (company_id) REFERENCES companies(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS sales_masters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            shift_id INTEGER,
            user_id INTEGER,
            customer_name TEXT DEFAULT 'زبون سفري',
            order_type TEXT DEFAULT 'takeaway', -- 'takeaway', 'local', 'delivery'
            table_number TEXT,
            total_items_price REAL DEFAULT 0,
            discount_amount REAL DEFAULT 0,
            tax_amount REAL DEFAULT 0,
            service_amount REAL DEFAULT 0,
            final_total REAL DEFAULT 0,
            paid_amount REAL DEFAULT 0,
            change_amount REAL DEFAULT 0,
            payment_method TEXT DEFAULT 'cash', -- 'cash', 'card', 'network'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (company_id) REFERENCES companies(id),
            FOREIGN KEY (shift_id) REFERENCES shifts(id),
            FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS sales_details (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sales_master_id INTEGER,
            product_id INTEGER,
            quantity REAL NOT NULL,
            unit_price REAL NOT NULL,
            total_price REAL NOT NULL,
            FOREIGN KEY (sales_master_id) REFERENCES sales_masters(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        );

        CREATE TABLE IF NOT EXISTS safe_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER,
            shift_id INTEGER,
            type TEXT, -- 'income', 'expense'
            amount REAL NOT NULL,
            source TEXT, -- 'sales', 'manual'
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (company_id) REFERENCES companies(id),
            FOREIGN KEY (shift_id) REFERENCES shifts(id)
        );
    `);

    // التأكد من وجود مستخدم مسؤول افتراضي إذا لم تكن هناك شركات
    const row = db.prepare('SELECT COUNT(*) as count FROM companies').get();
    if (row.count === 0) {
        // سيتم إنشاء الشركة عند أول فتح تلقائياً من الـ renderer
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 1024,
        minHeight: 768,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
    // mainWindow.webContents.openDevTools(); // يمكنك إلغاء التعليق لفحص الأخطاء إن وجدت
}

app.whenReady().then(() => {
    initializeDatabase();
    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

// ممرات الـ IPC الآمنة لقاعدة البيانات
function sendSuccess(data = null) { return { success: true, data }; }
function sendError(msg, err = '') { return { success: false, error: msg, details: err }; }

ipcMain.handle('db-query', async (event, sql, params = []) => {
    try {
        const rows = db.prepare(sql).all(params);
        return sendSuccess(rows);
    } catch (e) { return sendError('خطأ في جلب البيانات', e.message); }
});

ipcMain.handle('db-run', async (event, sql, params = []) => {
    try {
        const result = db.prepare(sql).run(params);
        return sendSuccess({ lastInsertRowid: result.lastInsertRowid, changes: result.changes });
    } catch (e) { return sendError('خطأ في تنفيذ العملية', e.message); }
});

ipcMain.handle('db-get', async (event, sql, params = []) => {
    try {
        const row = db.prepare(sql).get(params);
        return sendSuccess(row);
    } catch (e) { return sendError('خطأ في جلب السجل', e.message); }
});

// منطق تسجيل الدخول الخاص بالشركة والمستخدم
ipcMain.handle('login', async (event, { username, password, company_id }) => {
    try {
        const user = db.prepare('SELECT * FROM users WHERE username = ? AND company_id = ?').get([username, company_id]);
        if (!user) return sendError('اسم المستخدم غير صحيح التابع لهذا المطعم');
        if (user.is_blocked === 1) return sendError('هذا المستخدم محظور من النظام');
        
        const valid = bcrypt.compareSync(password, user.password_hash);
        if (!valid) return sendError('كلمة المرور غير صحيحة');
        
        return sendSuccess(user);
    } catch (e) { return sendError('خطأ في عملية تسجيل الدخول'); }
});

ipcMain.handle('create-user', async (event, data) => {
    try {
        const hash = bcrypt.hashSync(data.password, 10);
        const res = db.prepare(`
            INSERT INTO users (company_id, full_name, username, password_hash, role)
            VALUES (?, ?, ?, ?, ?)
        `).run([data.company_id, data.full_name, data.username, hash, data.role]);
        return sendSuccess(res.lastInsertRowid);
    } catch (e) { return sendError('خطأ في إنشاء المستخدم'); }
});

ipcMain.handle('update-user', async (event, data) => {
    try {
        if (data.password) {
            const hash = bcrypt.hashSync(data.password, 10);
            db.prepare('UPDATE users SET full_name=?, username=?, role=?, password_hash=? WHERE id=? AND company_id=?')
              .run([data.full_name, data.username, data.role, hash, data.id, data.company_id]);
        } else {
            db.prepare('UPDATE users SET full_name=?, username=?, role=? WHERE id=? AND company_id=?')
              .run([data.full_name, data.username, data.role, data.id, data.company_id]);
        }
        return sendSuccess();
    } catch (e) { return sendError('خطأ في تحديث بيانات المستخدم'); }
});

ipcMain.handle('create-company', async (event, { name }) => {
    try {
        const check = db.prepare('SELECT * FROM companies WHERE name = ?').get([name]);
        if (check) return sendSuccess({ alreadyExists: true, company: check });

        const res = db.prepare('INSERT INTO companies (name) VALUES (?)').run([name]);
        const cid = res.lastInsertRowid;
        
        // إنشاء إعدادات افتراضية للشركة
        db.prepare('INSERT INTO settings (company_id, receipt_header, receipt_footer) VALUES (?, ?, ?)')
          .run([cid, 'مطعم كيان الشواية البخاري', 'شكراً لزيارتكم - تقنيات سوفت']);
        
        // إنشاء مستخدم أدمن افتراضي
        const hash = bcrypt.hashSync('admin', 10);
        db.prepare('INSERT INTO users (company_id, full_name, username, password_hash, role) VALUES (?, ?, ?, ?, ?)')
          .run([cid, 'المدير العام', 'admin', hash, 'admin']);

        const company = { id: cid, name };
        return sendSuccess({ alreadyExists: false, company });
    } catch (e) { return sendError('خطأ في تهيئة المطعم الجديد', e.message); }
});

// حفظ المنتجات والمواد
ipcMain.handle('save-product', async (event, data) => {
    try {
        if (data.id) {
            db.prepare('UPDATE products SET category_id=?, name=?, price=?, image_path=?, is_available=? WHERE id=? AND company_id=?')
              .run([data.category_id, data.name, data.price, data.image_path, data.is_available, data.id, data.company_id]);
            return sendSuccess(data.id);
        } else {
            const res = db.prepare('INSERT INTO products (company_id, category_id, name, price, image_path) VALUES (?, ?, ?, ?, ?)')
              .run([data.company_id, data.category_id, data.name, data.price, data.image_path]);
            return sendSuccess(res.lastInsertRowid);
        }
    } catch (e) { return sendError('خطأ في حفظ المنتج'); }
});

ipcMain.handle('delete-product', async (event, { id, company_id }) => {
    try {
        db.prepare('DELETE FROM products WHERE id = ? AND company_id = ?').run([id, company_id]);
        return sendSuccess();
    } catch (e) { return sendError('لا يمكن حذف المنتج لارتباطه بعمليات بيع سابقة'); }
});

ipcMain.handle('save-material', async (event, data) => {
    try {
        if (data.id) {
            db.prepare('UPDATE inventory_materials SET name=?, unit=?, min_limit=? WHERE id=? AND company_id=?')
              .run([data.name, data.unit, data.min_limit, data.id, data.company_id]);
            return sendSuccess(data.id);
        } else {
            const res = db.prepare('INSERT INTO inventory_materials (company_id, name, unit, min_limit) VALUES (?, ?, ?, ?)')
              .run([data.company_id, data.name, data.unit, data.min_limit]);
            return sendSuccess(res.lastInsertRowid);
        }
    } catch (e) { return sendError('خطأ في حفظ المادة المخزنية'); }
});

ipcMain.handle('delete-material', async (event, { id, company_id }) => {
    try {
        db.prepare('DELETE FROM inventory_materials WHERE id = ? AND company_id = ?').run([id, company_id]);
        return sendSuccess();
    } catch (e) { return sendError('لا يمكن حذف المادة لارتباطها بجداول الإنتاج أو الفواتير'); }
});

ipcMain.handle('get-settings', async (event, company_id) => {
    try {
        let settings = db.prepare('SELECT * FROM settings WHERE company_id = ?').get([company_id]);
        if (!settings) {
            db.prepare('INSERT INTO settings (company_id, receipt_header, receipt_footer) VALUES (?, ?, ?)')
              .run([company_id, 'مطعم كيان الشواية البخاري', 'شكراً لزيارتكم - تقنيات سوفت']);
            settings = db.prepare('SELECT * FROM settings WHERE company_id = ?').get([company_id]);
        }
        return sendSuccess(settings);
    } catch (e) { return sendError('خطأ في جلب الإعدادات'); }
});

// التعامل مع الطباعة الحرارية المباشرة أو عبر نافذة وهمية للطباعة
ipcMain.on('print-thermal', (event, htmlContent) => {
    let printWindow = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true } });
    printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`);
    printWindow.webContents.on('did-finish-load', () => {
        printWindow.webContents.print({ silent: true, printBackground: true }, (success, failureReason) => {
            printWindow.destroy();
        });
    });
});

// النسخ الاحتياطي
ipcMain.handle('backup-database', async () => {
    try {
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            title: 'حفظ نسخة احتياطية من قاعدة البيانات',
            defaultPath: path.join(app.getPath('desktop'), `backup-restaurant-${Date.now()}.db`),
            filters: [{ name: 'Database', extensions: ['db'] }]
        });
        if (filePath) {
            fs.copyFileSync(dbPath, filePath);
            return sendSuccess({ filePath });
        }
        return sendSuccess({ cancelled: true });
    } catch (e) { return sendError('خطأ في تصدير النسخة الاحتياطية'); }
});

ipcMain.handle('restore-database', async () => {
    try {
        const { filePaths } = await dialog.showOpenDialog(mainWindow, {
            title: 'استيراد نسخة احتياطية',
            filters: [{ name: 'Database', extensions: ['db'] }],
            properties: ['openFile']
        });
        if (filePaths && filePaths[0]) {
            db.close();
            fs.copyFileSync(filePaths[0], dbPath);
            db = new Database(dbPath);
            return sendSuccess();
        }
        return sendSuccess({ cancelled: true });
    } catch (e) { return sendError(null, 'خطأ في استيراد النسخة الاحتياطية'); }
});

ipcMain.handle('save-image', async (event, { fileName, buffer }) => {
    try {
        const filePath = path.join(imagesDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(buffer));
        return sendSuccess({ imagePath: path.join('product-images', fileName) });
    } catch (e) {
        console.error('save-image error:', e.message);
        return sendError(event, 'خطأ في حفظ الصورة');
    }
});

ipcMain.handle('get-image-path', (event, relativePath) => {
    try {
        if (!relativePath) return sendSuccess({ path: '' });
        if (path.isAbsolute(relativePath)) return sendSuccess({ path: relativePath });
        const fullPath = path.join(userDataPath, relativePath);
        return sendSuccess({ path: fullPath });
    } catch (e) { return sendError(null, e.message); }
});
