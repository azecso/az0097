export default function Offline() {
  return (<main className="login"><div className="card" style={{ maxWidth: 460, textAlign: "center" }}><h1>📴 لا يوجد اتصال</h1>
    <p>هذه الصفحة غير متوفرة دون إنترنت بعد. الصفحات المتاحة أوفلاين: فاتورة بيع جديدة، عرض سعر جديد، سند قبض، مصروف، وصفحة المزامنة — بشرط أن تكون قد فتحتها وفعّلت «القفل المحلي» وأنت متصل.</p>
    <p><a href="/sync"><button className="primary">المزامنة</button></a> <a href="/sales/new"><button>فاتورة بيع جديدة</button></a></p></div></main>);
}
