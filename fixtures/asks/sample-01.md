<!-- SAMPLE for calibration plumbing — NOT part of the held-out 20-ask DoD set -->
---
id: sample-01
requester: calib-fixture-requester
role_lens: business
mode: front_door
stratum: big
---

Platform kullanıcıları şu an görselleri tek tek üretiyor. Power user'lar ve ajanslar için toplu (bulk) üretim akışı istiyoruz.

İstenen: kullanıcı bir kerede 10-50 görsellik bir batch job oluşturabilsin. Bu batch job'lar bir queue'da sıraya girsin; kullanıcı web-app'teki bir queue arayüzünde her job'ın ilerlemesini (pending / processing / done / failed) canlı görebilsin. Batch tamamlandığında kullanıcıya bir bildirim gitsin.

Bu iş üç parçadan oluşuyor: (1) api-service'e toplu tetikleme için bir batch endpoint, (2) web-app'e batch oluşturma + ilerleme takibi yapan bir queue UI, ve (3) batch-complete durumunda notification entegrasyonu.

Önemli sınırlar: kredi sistemine dokunmuyoruz — batch başına kredi düşümü mevcut per-generation akışını aynen kullanacak. Ayrıca yeni bir generation kategorisi de eklemiyoruz; sadece mevcut kategorilerde toplu (bulk) tetikleme yapıyoruz. Yani additive-safe bir iş.
