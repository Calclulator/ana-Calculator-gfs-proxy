# ana-Calculator GFS Proxy

NOMADS の GFS GRIB2 データを取得・パースして JSON で返す Vercel Functions 製の proxy。

## エンドポイント

```
GET /api/gfs?cycle=YYYYMMDDHH&fhr=N&west=W&east=E&south=S&north=N&vars=UGRD,VGRD,TMP,HGT
```

| パラメータ | 必須 | 例         | 説明                                |
|------------|------|------------|-------------------------------------|
| cycle      | yes  | 2026050400 | GFS サイクル (時刻は 00/06/12/18)   |
| fhr        | yes  | 3          | 予報時間 (0..384)                   |
| levels     | fixed| -          | (`lev` 未指定時) 300/275/250/225/200/175/150 mb を常時取得 |
| lev        | no   | 300        | 旧互換モード。指定時は単一レベルのみ返却 |
| west       | yes  | 139        | 経度の西端 (-180..360)              |
| east       | yes  | 241        | 経度の東端 (west < east)            |
| south      | yes  | 29         | 緯度の南端                          |
| north      | yes  | 41         | 緯度の北端 (south < north)          |
| vars       | no   | UGRD,VGRD  | カンマ区切り。デフォルト全 4 変数   |

サポート変数: `UGRD`, `VGRD`, `TMP`, `HGT`。

### レスポンス形式

```json
{
  "meta": {
    "cycle": "2026050400",
    "fhr": 3,
    "levels": [300, 275, 250, 225, 200, 175, 150],
    "refTime": { "year": 2026, "month": 5, "day": 4, "hour": 0, "minute": 0, "second": 0 },
    "forecastHours": 3,
    "messageCount": 28
  },
  "grid": {
    "nx": 409, "ny": 49,
    "la1": 41, "lo1": 139,
    "la2": 29, "lo2": 241
  },
  "vars": {
    "300": {
      "UGRD": [/* nx*ny floats, 2 decimals */],
      "VGRD": [...],
      "TMP":  [...],
      "HGT":  [...]
    },
    "275": { "...": "..." }
  }
}
```

データ配列は `nx * ny` の長さ。スキャン順は GFS 標準で「北西から東へ、行を変えながら南へ」(NOMADS の `subregion` 指定時)。インデックス `iy * nx + ix` で `(la1 - iy*dlat, lo1 + ix*dlon)` の値。

### CORS

`Access-Control-Allow-Origin: *` で開放。必要なら `api/gfs.js` の `setCors` を絞ること。

### キャッシュ

特定 cycle の GFS データは公開後不変なので、edge で 6時間キャッシュ (`s-maxage=21600`)。

## ローカル起動

```bash
npm install
npx vercel dev
```

`http://localhost:3000/api/gfs?...` でテスト可能。

## デプロイ

1. このリポジトリを GitHub に push
2. Vercel ダッシュボードで `Add New > Project` → 当該リポジトリを選択
3. Framework Preset は "Other" のまま
4. Deploy

`https://<project>.vercel.app/api/gfs?...` で公開される。

## 制限

- Vercel Hobby plan: maxDuration 60秒、レスポンスボディ 4.5MB まで
- NOMADS 側のレート制限: スクリプトでループする場合は 10秒スリープ推奨 (NOAA 公式アナウンス)
- GRIB2 パースは `grib2class` (pure JS, MIT) を使用。Simple/Complex/IEEE Float の各 packing に対応。JPEG2000 は未対応だが GFS 0.25度では Simple/Complex のみなので問題なし

## 1リクエストの粒度

「1 cycle × 1 fhr × 7 levels × N vars」で 1 ファイル。複数予報時刻はブラウザ側で並列に呼ぶこと。

`lev` を指定した場合のみ旧仕様の「1 cycle × 1 fhr × 1 level × N vars」で返す。

## トラブルシュート

| 症状                              | 原因/対処                                                                |
|-----------------------------------|--------------------------------------------------------------------------|
| 502 NOMADS responded 404          | cycle が古すぎる (NOMADS は概ね 10日分しか保持) または fhr/lev の指定ミス |
| 502 no GRIB messages              | NOMADS が空ファイル/HTML エラーを返した。URL を直接ブラウザで開いて確認 |
| 504 timeout                       | NOMADS が遅延中。リトライまたは cycle を 1つ前に変更                     |
| `vars: { UNK_X,Y,Z: [...] }`      | 想定外の変数が混入。`api/gfs.js` の `VAR_MAP` を更新                     |

## ライセンス

依存: [grib2class](https://github.com/archmoj/grib2class) (MIT)
