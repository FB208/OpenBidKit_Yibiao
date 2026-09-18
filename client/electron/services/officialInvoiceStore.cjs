// 读写当前工作区的开票信息，固定保留一份。
function createOfficialInvoiceStore({ db }) {
  // 首次填写前返回空白表单。
  function get() {
    return db.prepare(`SELECT title_type AS titleType, buyer, tax_number AS taxNumber, email
      FROM official_invoice_info WHERE id = 1`).get()
      || { titleType: 'enterprise', buyer: '', taxNumber: '', email: '' };
  }

  // 一次写入完整表单，重复保存更新同一条记录。
  function save(info) {
    db.prepare(`INSERT INTO official_invoice_info (id, title_type, buyer, tax_number, email)
      VALUES (1, @titleType, @buyer, @taxNumber, @email)
      ON CONFLICT(id) DO UPDATE SET title_type = excluded.title_type,
        buyer = excluded.buyer, tax_number = excluded.tax_number, email = excluded.email`).run(info);
  }

  return { get, save };
}

module.exports = { createOfficialInvoiceStore };
