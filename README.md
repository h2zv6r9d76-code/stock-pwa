# 在庫管理PWA

## 機能
- 在庫の追加・編集・削除
- 商品名、分類、場所、メモ検索
- 写真保存（長辺1200px、JPEG圧縮）
- IndexedDBへ端末内保存
- JSONバックアップ／復元（画像を含む）
- オフライン動作
- ホーム画面アプリ対応

## GitHub Pages
1. GitHubで新しいPublicリポジトリを作る
2. このフォルダ内のファイルをすべてアップロード
3. Settings → Pages
4. Build and deployment → Deploy from a branch
5. Branchを main、Folderを /(root) にしてSave
6. 表示されたURLをiPhoneのSafariで開く
7. 共有 → ホーム画面に追加

注意：プログラムは公開されますが、在庫データと画像は端末内のIndexedDBに保存され、GitHubへ送信されません。
