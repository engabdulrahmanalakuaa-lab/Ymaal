// ==========================================
// renderer.js - تقنيات سوفت (نسخة بدون تفعيل)
// تصميم م/ عبدالرحمن الاكوع 773579486 967+
// ==========================================

const api = window.api;

let currentUser = null;
let currentCompany = null;
let currentShift = null;
let cart = [];
let totalSalesCash = 0;
let currentCategory = 'all';

// ============ بدء التشغيل ============\nwindow.addEventListener('DOMContentLoaded', async () => {
    // تجاوز شاشة التفعيل والدخول مباشرة
    document.getElementById('app-main').style.display = 'flex';
    await showLoginScreen();
});

// ============ شاشة الدخول وإنشاء الشركة ============\nasync function showLoginScreen() {
    const companiesResult = await api.dbQuery('SELECT * FROM companies');
    if (!companiesResult.success) {
        alert('خطأ في الاتصال بقاعدة البيانات');
        return;
    }
    const companies = companiesResult.data;
    let company = null;

    if (companies.length === 0) {
        const name = "مطعم كيان الشواية البخاري";
        const result = await api.createCompany(name);
        if (!result.success) {
            alert('خطأ في إنشاء المطعم: ' + result.error);
            return;
        }
        company = { id: result.data.company.id, name: name };
    } else {
        company = companies[0];
    }

    currentCompany = company;
    document.getElementById('app-company-name').innerText = company.name;
    await loadUsersAndFillSelect();
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('pos-interface').style.display = 'none';
}

async function loadUsersAndFillSelect() {
    const res = await api.dbQuery('SELECT id, full_name, username FROM users WHERE company_id = ? AND is_blocked = 0', [currentCompany.id]);
    const select = document.getElementById('login-user-select');
    select.innerHTML = '';
    if (res.success) {
        res.data.forEach(u => {
            select.innerHTML += `<option value="${u.username}">${u.full_name} (${u.username})</option>`;
        });
    }
}

async function handleLogin() {
    const username = document.getElementById('login-user-select').value;
    const pass = document.getElementById('login-password').value;
    if (!username || !pass) return alert('الرجاء إدخال البيانات كاملة');

    const res = await api.login(username, pass, currentCompany.id);
    if (res.success) {
        currentUser = res.data;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('pos-interface').style.display = 'flex';
        document.getElementById('user-display-name').innerText = currentUser.full_name;
        
        // إظهار لوحة التحكم للمشرفين فقط
        if (currentUser.role === 'admin') {
            document.getElementById('nav-admin-btn').style.display = 'block';
        } else {
            document.getElementById('nav-admin-btn').style.display = 'none';
        }
        
        await checkAndManageShift();
    } else {
        alert(res.error);
    }
}

function logout() {
    currentUser = null;
    currentShift = null;
    cart = [];
    updateCartUI();
    document.getElementById('login-password').value = '';
    showLoginScreen();
}

// ============ إدارة الوردية (الورديات المحاسبية) ============\nasync function checkAndManageShift() {
    const openShiftRes = await api.dbGet('SELECT * FROM shifts WHERE company_id = ? AND status = "open"', [currentCompany.id]);
    if (openShiftRes.success && openShiftRes.data) {
        currentShift = openShiftRes.data;
        document.getElementById('shift-status-text').innerText = `الوردية مفتوحة (رقم: ${currentShift.id})`;
        await loadPosData();
    } else {
        const initial = prompt('لا توجد وردية مفتوحة حالياً، أدخل المبلغ الافتتاحي لبدء الصندوق المالي (SR):', '0');
        if (initial === null) {
            logout();
            return;
        }
        const balance = parseFloat(initial) || 0;
        const insertRes = await api.dbRun(`
            INSERT INTO shifts (company_id, user_id, initial_balance, status)
            VALUES (?, ?, ?, 'open')
        `, [currentCompany.id, currentUser.id, balance]);
        
        if (insertRes.success) {
            const newShift = await api.dbGet('SELECT * FROM shifts WHERE id = ?', [insertRes.data.lastInsertRowid]);
            currentShift = newShift.data;
            document.getElementById('shift-status-text').innerText = `الوردية مفتوحة (رقم: ${currentShift.id})`;
            await loadPosData();
        } else {
            alert('خطأ في فتح الوردية المالي');
            logout();
        }
    }
}

async function closeCurrentShift() {
    if (!currentShift) return;
    
    const salesSum = await api.dbGet('SELECT SUM(final_total) as total FROM sales_masters WHERE shift_id = ?', [currentShift.id]);
    const totalSales = salesSum.data.total || 0;
    
    const safeLogsSum = await api.dbGet('SELECT SUM(amount) as total FROM safe_logs WHERE shift_id = ? AND type="expense"', [currentShift.id]);
    const totalExpenses = safeLogsSum.data.total || 0;
    
    const expectedBalance = currentShift.initial_balance + totalSales - totalExpenses;

    const confirmClose = confirm(`إغلاق الوردية الحالية؟\n\nرأس المال الافتتاحي: ${currentShift.initial_balance} SR\nإجمالي المبيعات: ${totalSales} SR\nالمصاريف المستقطعة: ${totalExpenses} SR\nالمبلغ المتوقع بالخزينة: ${expectedBalance} SR`);
    if (!confirmClose) return;

    const endInput = prompt('أدخل المبلغ الفعلي الموجود في الدرج المالي الآن لتوثيق العجز/الفائض (SR):', expectedBalance.toString());
    if (endInput === null) return;
    const actualBalance = parseFloat(endInput) || 0;

    await api.dbRun(`
        UPDATE shifts 
        SET end_time = CURRENT_TIMESTAMP, end_balance = ?, status = 'closed'
        WHERE id = ?
    `, [actualBalance, currentShift.id]);

    // إضافة السجل المالي النهائي للخزنة المركزية
    await api.dbRun(`
        INSERT INTO safe_logs (company_id, shift_id, type, amount, source, notes)
        VALUES (?, ?, 'income', ?, 'sales', ?)
    `, [currentCompany.id, currentShift.id, totalSales, `إغلاق مبيعات الوردية رقم ${currentShift.id}`]);

    alert('تم إغلاق الوردية وتوثيق الحسابات بنجاح.');
    logout();
}

// ============ تحميل البيانات وواجهة البيع ============\nasync function loadPosData() {
    await loadCategories();
    await loadProducts();
    updateCartUI();
}

async function loadCategories() {
    const res = await api.dbQuery('SELECT * FROM categories WHERE company_id = ?', [currentCompany.id]);
    const container = document.getElementById('categories-list');
    container.innerHTML = `<button class="category-btn active" onclick="filterCategory('all', this)">الكل</button>`;
    if (res.success) {
        res.data.forEach(c => {
            container.innerHTML += `<button class="category-btn" onclick="filterCategory(${c.id}, this)">${c.name}</button>`;
        });
    }
}

async function loadProducts() {
    let sql = 'SELECT * FROM products WHERE company_id = ? AND is_available = 1';
    let params = [currentCompany.id];
    if (currentCategory !== 'all') {
        sql += ' AND category_id = ?';
        params.push(currentCategory);
    }
    const res = await api.dbQuery(sql, params);
    const container = document.getElementById('products-grid');
    container.innerHTML = '';
    
    if (res.success) {
        for (let p of res.data) {
            let imgHtml = `<div class="product-img-placeholder">🍲</div>`;
            if (p.image_path) {
                const pPathRes = await api.getImagePath(p.image_path);
                if (pPathRes.success && pPathRes.data) {
                    imgHtml = `<img src="file://${pPathRes.data.path.replace(/\\/g, '/')}" class="product-img" onerror="this.style.display='none'">`;
                }
            }
            container.innerHTML += `
                <div class="product-card" onclick="addToCart(${p.id}, '${p.name.replace(/'/g, "\\'")}', ${p.price})">
                    ${imgHtml}
                    <div class="product-info">
                        <div class="product-name">${p.name}</div>
                        <div class="product-price">${p.price.toFixed(2)} SR</div>
                    </div>
                </div>
            `;
        }
    }
}

function filterCategory(catId, btn) {
    currentCategory = catId;
    document.querySelectorAll('.category-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    loadProducts();
}

// ============ منطق سلة المشتريات ============\nfunction addToCart(id, name, price) {
    const item = cart.find(i => i.product_id === id);
    if (item) {
        item.quantity += 1;
        item.total_price = item.quantity * item.price;
    } else {
        cart.push({
            product_id: id,
            name: name,
            price: price,
            quantity: 1,
            total_price: price
        });
    }
    updateCartUI();
}

function changeQty(index, amount) {
    cart[index].quantity += amount;
    if (cart[index].quantity <= 0) {
        cart.splice(index, 1);
    } else {
        cart[index].total_price = cart[index].quantity * cart[index].price;
    }
    updateCartUI();
}

function removeFromCart(index) {
    cart.splice(index, 1);
    updateCartUI();
}

function clearCart() {
    cart = [];
    updateCartUI();
}

function updateCartUI() {
    const tbody = document.getElementById('cart-items-tbody');
    tbody.innerHTML = '';
    let totalItemsPrice = 0;

    cart.forEach((item, index) => {
        totalItemsPrice += item.total_price;
        tbody.innerHTML += `
            <tr>
                <td>${item.name}</td>
                <td>
                    <div class="qty-controls">
                        <button onclick="changeQty(${index}, -1)">-</button>
                        <span>${item.quantity}</span>
                        <button onclick="changeQty(${index}, 1)">+</button>
                    </div>
                </td>
                <td>${item.price.toFixed(2)}</td>
                <td>${item.total_price.toFixed(2)}</td>
                <td><button class="delete-btn" onclick="removeFromCart(${index})">🗑</button></td>
            </tr>
        `;
    });

    const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const taxRate = parseFloat(document.getElementById('cart-tax-rate').value) || 0;
    
    const taxAmount = (totalItemsPrice - discount) * (taxRate / 100);
    const finalTotal = (totalItemsPrice - discount) + taxAmount;

    document.getElementById('summary-subtotal').innerText = totalItemsPrice.toFixed(2) + ' SR';
    document.getElementById('summary-tax').innerText = taxAmount.toFixed(2) + ' SR';
    document.getElementById('summary-total').innerText = finalTotal.toFixed(2) + ' SR';
    
    calculateChange();
}

function calculateChange() {
    const totalText = document.getElementById('summary-total').innerText;
    const finalTotal = parseFloat(totalText) || 0;
    const paid = parseFloat(document.getElementById('cart-paid').value) || 0;
    const change = paid - finalTotal;
    document.getElementById('summary-change').innerText = (change > 0 ? change : 0).toFixed(2) + ' SR';
}

// ============ حفظ الفاتورة والطباعة الحرارية ============
async function checkoutAndPrint() {
    if (cart.length === 0) return alert('سلة المشتريات فارغة');
    if (!currentShift) return alert('الوردية المحاسبية مغلقة');

    const customerName = document.getElementById('customer-name').value.trim() || 'زبون سفري';
    const orderType = document.getElementById('order-type').value;
    const tableNumber = document.getElementById('table-number').value.trim() || '';
    const paymentMethod = document.getElementById('payment-method').value;

    const totalText = document.getElementById('summary-total').innerText;
    const finalTotal = parseFloat(totalText) || 0;
    const subtotalText = document.getElementById('summary-subtotal').innerText;
    const totalItemsPrice = parseFloat(subtotalText) || 0;
    
    const discount = parseFloat(document.getElementById('cart-discount').value) || 0;
    const taxRate = parseFloat(document.getElementById('cart-tax-rate').value) || 0;
    const taxAmount = (totalItemsPrice - discount) * (taxRate / 100);
    
    const paid = parseFloat(document.getElementById('cart-paid').value) || finalTotal;
    const change = paid - finalTotal;

    // 1. حفظ رأس الفاتورة في قاعدة البيانات
    const masterRes = await api.dbRun(`
        INSERT INTO sales_masters (company_id, shift_id, user_id, customer_name, order_type, table_number, total_items_price, discount_amount, tax_amount, final_total, paid_amount, change_amount, payment_method)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [currentCompany.id, currentShift.id, currentUser.id, customerName, orderType, tableNumber, totalItemsPrice, discount, taxAmount, finalTotal, paid, (change > 0 ? change : 0), paymentMethod]);

    if (!masterRes.success) {
        alert('حدث خطأ أثناء حفظ الفاتورة في النظام');
        return;
    }

    const masterId = masterRes.data.lastInsertRowid;

    // 2. حفظ تفاصيل المنتجات والخصم من المستودع تلقائياً
    for (let item of cart) {
        await api.dbRun(`
            INSERT INTO sales_details (sales_master_id, product_id, quantity, unit_price, total_price)
            VALUES (?, ?, ?, ?, ?)
        `, [masterId, item.product_id, item.quantity, item.price, item.total_price]);

        // خصم المكونات من المخزن إن وجدت علاقات ربط المواد
        const ingredients = await api.dbQuery('SELECT * FROM product_ingredients WHERE product_id = ?', [item.product_id]);
        if (ingredients.success) {
            for (let ing of ingredients.data) {
                const neededQty = ing.required_qty * item.quantity;
                await api.dbRun('UPDATE inventory_materials SET quantity = quantity - ? WHERE id = ?', [neededQty, ing.material_id]);
                await api.dbRun(`
                    INSERT INTO inventory_transactions (company_id, material_id, type, quantity, notes)
                    VALUES (?, ?, 'out', ?, ?)
                `, [currentCompany.id, ing.material_id, neededQty, `سحب إنتاج تلقائي لفاتورة بيع رقم: ${masterId}`]);
            }
        }
    }

    // 3. تجهيز قالب HTML المخصص للطباعة على الطابعات الحرارية (Thermal Printer 80mm)
    let itemsRowsHtml = '';
    cart.forEach(i => {
        itemsRowsHtml += `
            <tr>
                <td style="padding:5px; font-size:13px;">${i.name}</td>
                <td style="text-align:center; font-size:13px;">${i.quantity}</td>
                <td style="text-align:left; font-size:13px;">${i.total_price.toFixed(2)}</td>
            </tr>
        `;
    });

    const receiptHtml = `
        <div dir="rtl" style="font-family:'Tajawal', sans-serif; width: 280px; padding: 5px; color: #000;">
            <div style="text-align: center; margin-bottom: 10px;">
                <h2 style="margin: 2px 0; font-size: 18px;">مطعم كيان الشواية البخاري</h2>
                <p style="margin: 2px 0; font-size: 12px;">مبيعات الكاشير - نظام الفواتير المحكم</p>
                <p style="margin: 2px 0; font-size: 11px;">تاريخ الفاتورة: ${new Date().toLocaleString('ar-YE')}</p>
                <p style="margin: 2px 0; font-size: 13px; font-weight: bold;">رقم الفاتورة: #${masterId}</p>
            </div>
            <hr style="border-top: 1px dashed #000; margin: 5px 0;">
            <p style="margin: 3px 0; font-size: 12px;"><b>العميل:</b> ${customerName} | <b>النوع:</b> ${orderType === 'takeaway' ? 'سفري' : orderType === 'local' ? 'محلي' : 'توصيل'}</p>
            ${tableNumber ? `<p style="margin: 3px 0; font-size: 12px;"><b>رقم الطاولة:</b> ${tableNumber}</p>` : ''}
            <hr style="border-top: 1px dashed #000; margin: 5px 0;">
            
            <table style="width: 100%; border-collapse: collapse;">
                <thead>
                    <tr style="border-bottom: 1px solid #000;">
                        <th style="text-align:right; font-size:12px; padding-bottom:3px;">الصنف</th>
                        <th style="text-align:center; font-size:12px; padding-bottom:3px;">الكمية</th>
                        <th style="text-align:left; font-size:12px; padding-bottom:3px;">المجموع</th>
                    </tr>
                </thead>
                <tbody>
                    ${itemsRowsHtml}
                </tbody>
            </table>
            
            <hr style="border-top: 1px dashed #000; margin: 5px 0;">
            <table style="width: 100%; font-size: 13px;">
                <tr><td>المجموع الافتراضي:</td><td style="text-align:left;">${totalItemsPrice.toFixed(2)} SR</td></tr>
                ${discount > 0 ? `<tr><td>الخصم الممنوح:</td><td style="text-align:left;">-${discount.toFixed(2)} SR</td></tr>` : ''}
                ${taxAmount > 0 ? `<tr><td>الضريبة (${taxRate}%):</td><td style="text-align:left;">${taxAmount.toFixed(2)} SR</td></tr>` : ''}
                <tr style="font-weight:bold; font-size:15px;"><td>الصافي الإجمالي:</td><td style="text-align:left;">${finalTotal.toFixed(2)} SR</td></tr>
                <tr style="color:#555; font-size:12px;"><td>المبلغ المدفوع:</td><td style="text-align:left;">${paid.toFixed(2)} SR</td></tr>
                <tr style="color:#555; font-size:12px;"><td>المبلغ المتبقي:</td><td style="text-align:left;">${(change > 0 ? change : 0).toFixed(2)} SR</td></tr>
            </table>
            
            <hr style="border-top: 1px dashed #000; margin: 5px 0;">
            <div style="text-align: center; margin-top: 10px; font-size: 11px;">
                <p style="margin:2px 0;">شكراً لزيارتكم وصحتين وعافية</p>
                <p style="margin:2px 0; font-weight:bold; color:#2c3e50;">برمجة وتطوير: م/ عبدالرحمن الأكوع (773579486)</p>
            </div>
        </div>
    `;

    api.printThermal(receiptHtml);

    // تفريغ السلة وإعادة تهيئة الشاشة للفاتورة التالية
    cart = [];
    document.getElementById('customer-name').value = '';
    document.getElementById('table-number').value = '';
    document.getElementById('cart-paid').value = '';
    document.getElementById('cart-discount').value = '0';
    updateCartUI();
    alert('تم حفظ الفاتورة وإرسال أمر الطباعة بنجاح.');
}

// ============ وظائف أخرى المساعدة ولوحة الأرقام الوهمية ============
let kbActiveInput = null;
function showKeyboard(inputEl) {
    kbActiveInput = inputEl;
    document.getElementById('virtual-keyboard').style.display = 'block';
    switchKBMode('number');
}

function hideKeyboard() {
    document.getElementById('virtual-keyboard').style.display = 'none';
    kbActiveInput = null;
}

function switchKBMode(mode) {
    const container = document.getElementById('kb-keys-container');
    container.innerHTML = '';
    let keys = [];
    if (mode === 'number') {
        keys = [
            ['1', '2', '3'],
            ['4', '5', '6'],
            ['7', '8', '9'],
            ['0', '.', '00']
        ];
    }
    let html = '';
    for (let row of keys) {
        for (let key of row) {
            html += `<button class="kb-btn" onclick="kbInsert('${key}')" style="background:white; border:1px solid #ccc; border-radius:6px; padding:10px; font-size:16px; font-weight:bold;">${key}</button>`;
        }
    }
    container.innerHTML = html;
}

function kbInsert(char) {
    if (!kbActiveInput) return;
    kbActiveInput.value = (kbActiveInput.value || '') + char;
    kbActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function kbBackspace() {
    if (!kbActiveInput) return;
    kbActiveInput.value = kbActiveInput.value.slice(0, -1);
    kbActiveInput.dispatchEvent(new Event('input', { bubbles: true }));
}

function kbEnter() {
    hideKeyboard();
    if (kbActiveInput) {
        kbActiveInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }));
    }
}

document.addEventListener('focusin', (e) => {
    if (e.target.tagName === 'INPUT' && (e.target.id === 'cart-paid' || e.target.id === 'cart-discount')) {
        showKeyboard(e.target);
    }
});
