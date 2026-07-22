# Eczacı Haber Merkezi

Türkiye eczacılık sektöründen resmi kurum duyurularını, ilaç geri çekme
bildirimlerini, TEB ve eczacı odaları haberlerini tek bir sayfada toplayan
statik haber portalı.

## Nasıl çalışır?

- `config/sources.json` taranacak kaynakların listesidir (isim, kategori,
  ana sayfa, tarama yöntemi).
- `scripts/scrape.mjs` bu kaynakları tarar: önce RSS beslemesi arar
  (sayfadaki `<link rel="alternate">` etiketi veya `/feed`, `/rss` gibi
  bilinen adresler), bulamazsa kaynağı **"yapılandırma bekliyor"** olarak
  işaretler — sahte/hatalı veri üretmez.
- Sonuç `data/news.json` dosyasına yazılır. Bu dosya statik sitenin
  okuduğu tek veri kaynağıdır.
- `.github/workflows/scrape.yml` bu betiği düzenli aralıklarla (3 saatte
  bir + elle tetikleme) GitHub Actions üzerinde çalıştırır ve değişiklik
  varsa `data/news.json` dosyasını otomatik commit'ler.
- `index.html` + `assets/` sadece `data/news.json` ve `config/categories.json`
  dosyalarını okuyan, build aracı gerektirmeyen saf HTML/CSS/JS bir arayüzdür.
  GitHub Pages gibi herhangi bir statik barındırma ile doğrudan çalışır.

## Yeni bir sekme (konu/kategori) eklemek

1. `config/categories.json` dosyasına yeni bir kategori objesi ekleyin:
   ```json
   { "id": "mevzuat", "label": "Mevzuat Değişiklikleri", "description": "..." }
   ```
2. Bu kategoriye ait kaynakları `config/sources.json` içinde
   `"category": "mevzuat"` ile işaretleyin (bkz. aşağıdaki adım).
3. Başka bir şey yapmanıza gerek yok — arayüz sekmeleri
   `config/categories.json` dosyasından otomatik üretir.

## Yeni bir kaynak eklemek

`config/sources.json` dosyasına yeni bir obje ekleyin:

```json
{
  "id": "benzersiz-kisa-id",
  "name": "Görünen İsim",
  "homepage": "https://ornek-site.gov.tr/duyurular",
  "category": "resmi-kurumlar",
  "type": "auto",
  "verified": true,
  "notes": "Kısa açıklama"
}
```

- `type: "auto"` → önce RSS otomatik keşfi dener. Deneyin ama çoğu Türkiye
  kurum/kuruluş sitesinde RSS otomatik keşfi (standart `<link rel="alternate">`
  etiketi) bulunmuyor; bu durumda kaynak "yapılandırma bekliyor" olarak kalır.
- `type: "auto-template"` → RSS keşfini dener, olmazsa `scripts/scrape.mjs`
  içindeki `TEMPLATE_LIBRARY`'deki bilinen site şablonlarını (ör.
  "duzce-tarzi", "aeo-tarzi") sırayla dener; biri ≥2 anlamlı öğe üretirse
  otomatik olarak o şablonla yapılandırılmış olur (`matchedTemplate` alanında
  görülür). 59 eczacı odasının çoğu bu tip ile eklendi çünkü aynı birkaç
  web sitesi şablonunu paylaşıyorlar. Hiçbiri eşleşmezse "yapılandırma
  bekliyor" olur ve `type: "html"`'e elle CSS seçicisiyle geçmek gerekir.
  Yeni bir ortak şablon keşfedildikçe `TEMPLATE_LIBRARY`'ye eklemek, o
  şablonu kullanan tüm kaynakları otomatik kapsar.
- `type: "rss"` + `"feedUrl": "https://..."` → adresi bilinen bir RSS/Atom beslemesi.
- `type: "html"` → CSS seçicili liste taraması, pratikte en güvenilir yöntem:
  ```json
  {
    "type": "html",
    "listUrl": "https://ornek-site.gov.tr/duyurular",
    "selectors": {
      "item": ".duyuru-listesi li",
      "title": ".baslik",
      "link": "a",
      "date": ".tarih"
    }
  }
  ```
  `title`/`date` için metin yerine bir HTML attribute'u okumak gerekiyorsa
  (ör. `<a title="Temiz Başlık">`) `titleAttr`/`dateAttr` alanlarını ekleyin.

  Bu seçicileri doğru yazabilmek için sitenin gerçek HTML yapısını görmek
  gerekir. Bunun için `.github/workflows/diagnose.yml` workflow'unu elle
  tetikleyin (`workflow_dispatch`): kaynakların ham HTML'ini
  indirip ilgili linkleri (`rss`/`duyuru`/`haber` içeren) çıkarır ve hem bir
  GitHub Actions artifact'i olarak hem de `diagnostics-output` branch'ine
  commit olarak yayınlar (artifact indirme bazı ortamlardan erişilemeyebilir,
  branch her zaman çalışır). Yeni bir kaynağı `config/sources.json`'a eklerken
  gerekirse `diagnoseUrls: ["https://.../aday-sayfa"]` ile ek aday sayfalar da
  taratabilirsiniz. Çıktıyı inceleyip gerçek seçicileri yazdıktan sonra
  `verified: true` yapın; belirsizlik varsa `verified: false` + `notes`
  alanına not düşüp ilk gerçek taramadan sonra doğrulayın.

`data/news.json` içindeki `sources` listesi her kaynağın canlı durumunu
(`ok` / `empty` / `needs-config` / `error`) gösterir; arayüzdeki
**Kaynaklar** sekmesinden de görülebilir. Bu, 59 eczacı odasının tamamını
kademeli ve doğrulanabilir şekilde eklemek için tasarlandı.

## Yerelde çalıştırma

```bash
npm install
npm run scrape        # data/news.json dosyasını günceller
python3 -m http.server 8080   # veya herhangi bir statik sunucu
```

## Bilinen sınırlamalar / yapılacaklar

- 7 çekirdek kaynak (TİTCK duyuru + geri çekme, Sağlık Bakanlığı basın
  duyuruları, TEB, Düzce Eczacı Odası, Ankara Eczacı Odası, Eczacının Sesi)
  `type: "html"` ile gerçek sayfa yapısı doğrulanarak eklendi (22.07.2026
  tanılaması, bkz. `config/sources.json` `notes` alanları).
- TEB'in resmi oda listesindeki
  (`https://www.teb.org.tr/content/28/Eczac%C4%B1-Odalar%C4%B1-Listesi`)
  kalan 57 eczacı odasının tamamı `type: "auto-template"` ile eklendi.
  `data/news.json` içindeki `sources` listesinden hangilerinin otomatik
  eşleştiğini (`matchedTemplate` alanı) ve hangilerinin "yapılandırma
  bekliyor" kaldığını görebilirsiniz. Eşleşmeyenler için: tanılama
  workflow'unu o kaynağın `homepage`'iyle çalıştırıp gerçek yapıyı görün,
  `TEMPLATE_LIBRARY`'ye yeni bir şablon ekleyin (birden fazla oda aynı
  şablonu kullanıyorsa) ya da o kaynağı `type: "html"` + özel seçicilerle
  yapılandırın.
- Bazı kaynaklarda (TEB, Sağlık Bakanlığı, Ankara Eczacı Odası ve
  auto-template ile eşleşen bazı odalar) sayfa yapısı gereği ayrı bir
  tarih alanı ayrıştırılamıyor; bu kaynaklardaki haberler tarama zamanına
  göre sıralanır (başlıkta tarih bilgisi genelde zaten mevcuttur).
