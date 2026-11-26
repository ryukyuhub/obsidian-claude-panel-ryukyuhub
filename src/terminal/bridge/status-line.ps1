# ターミナル UI のステータスライン(Windows PowerShell 5.1 用)
#
# 起動: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File status-line.ps1
#   stdin : claude が渡す JSON(UTF-8)
#   stdout: 「モデル名 · effort: 段階」の 1 行(UTF-8)。effort が無ければモデル名だけ
#   取れないとき・失敗したときは何も書かず、終了コードは常に 0
#
# PowerShell 7 から継いだ PSModulePath があると 5.1 の標準コマンドが読めないので、
# コマンドレット(ConvertFrom-Json など)は使わず .NET だけで書く。
# このファイルは BOM なしで置き、一時ファイルへ書き出すときに BOM を付ける(BOM が無いと 5.1 は ANSI として読む)

$ErrorActionPreference = 'Stop'

function Get-Text($node, [string[]]$keys) {
    foreach ($key in $keys) {
        if (-not ($node -is [System.Collections.Generic.IDictionary[string, object]])) { return '' }
        if (-not $node.ContainsKey($key)) { return '' }
        $node = $node[$key]
    }
    if (-not ($node -is [string])) { return '' }
    # Python の isprintable() に合わせ、制御・書式・私用・未割り当て・行/段落区切り・半角空白以外の空白と、ペアになっていないサロゲートを除く
    # (絵文字などのサロゲートペアは残す)
    $text = $node -replace '[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}-[ ]]', ''
    $text = $text -replace '[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]', ''
    return $text.Trim()
}

try {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), $utf8)
    $raw = $reader.ReadToEnd()
    [void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
    $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
    $serializer.MaxJsonLength = [int]::MaxValue
    $data = $serializer.DeserializeObject($raw)
    $model = Get-Text $data @('model', 'display_name')
    $effort = Get-Text $data @('effort', 'level')
    if ($model) {
        $line = $model
        if ($effort) { $line += ' ' + [char]0x00B7 + ' effort: ' + $effort }
        $bytes = $utf8.GetBytes($line + "`n")
        $stdout = [Console]::OpenStandardOutput()
        $stdout.Write($bytes, 0, $bytes.Length)
        $stdout.Flush()
    }
} catch {
}
# [Environment]::Exit は 5.1 では終了までに 2 秒あまりかかるので使わない
exit 0
