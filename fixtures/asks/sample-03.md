<!-- SAMPLE for plumbing — NOT part of the held-out 20-ask DoD set.
     Purpose: exercises the GROOM-REGEN SELF-HEAL path (FIX B) in --dry-run. The
     a0 groom envelope (fixtures/dryrun/groom__sample-03.json) anchors into
     api-service:internal/account/balance.go — a shared-write
     no-go-zone member — while declaring coupling_zones ["none"], so treecheck
     plan mode hard-fails zone_routing. The harness then RE-ASKS the Groomer with
     the zone_routing complaint appended; the a1 regen (groom__sample-03__a1.json)
     corrects the routing (coupling_zones ["shared-write"] + needs-human + high)
     and PASSES the deterministic gate. The a1 output also OMITS top-level
     plan_id/requester/role_lens/mode, so the run exercises FIX A (harness-injected
     request metadata) on the regenerated plan. -->
---
id: sample-03
requester: calib-fixture-requester
role_lens: business
mode: front_door
stratum: small
---

Generation başına kredi düşümü loglarda takip edilemiyor. api-service kredi düşerken structured log yazmıyor; destek ekibi bir kullanıcının "kredim yanlış düştü" şikayetini araştırırken hangi generation'ın kaç kredi düşürdüğünü göremiyor.

İstenen: api-service'te kredi düşümünün yapıldığı yerde (credit service) her düşüm için user_id, generation_id, düşülen kredi miktarı ve kalan bakiyeyi içeren tek satırlık structured bir log satırı eklensin. Davranış değişikliği yok, sadece observability.
