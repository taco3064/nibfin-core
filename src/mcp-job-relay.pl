use strict;
use warnings;
use Socket qw(AF_UNIX SOCK_STREAM SOL_SOCKET SO_PEERCRED SHUT_WR sockaddr_un);
use IO::Select;
use JSON::PP;
use Fcntl qw(O_RDONLY O_NOFOLLOW);
use Digest::SHA qw(sha256_hex);
use Cwd qw(realpath);

# Fixed, root-adopted endpoint. No command, destination or identity on argv.
# The enrolled Windows startup invokes this installed file via fixed wsl.exe.
my $config = '/etc/nibfin/mcp-relay.json';
my $limit = 1024 * 1024;
my ($server, $peer, $path, $data_server, $data_peer, $data_path);
sub check { die "MCP_JOB_RELAY_REJECTED\n" unless $_[0]; }
sub protected_path {
    my ($name, $directory, $program) = @_;
    my @s = lstat($name);
    check(@s && $s[4] == 0 && ($s[2] & 0022) == 0 && !-l _);
    check($directory ? -d _ : -f _ && ($program || $s[3] == 1));
}
sub write_all {
    my ($file, $bytes) = @_;
    while (length $bytes) {
        my $count = syswrite($file, $bytes);
        check(defined($count) && $count > 0);
        substr($bytes, 0, $count, '');
    }
}
sub validate_binding {
    my ($binding) = @_;
    check(ref($binding) eq 'HASH' && join(',', sort keys %$binding) eq
        'attempt,jobId,memberId,repositoryId,runId,runnerId');
    for my $value (values %$binding) {
        check(encode_json([$value]) =~ /^\[[1-9][0-9]*\]$/ &&
            $value < 9007199254740992);
    }
}
sub main {
    check($> == 0 && (@ARGV == 0 ||
        (@ARGV == 1 && $ARGV[0] eq '--response')));
    protected_path('/etc/nibfin', 1);
    protected_path($config, 0);
    sysopen(my $file, $config, O_RDONLY | O_NOFOLLOW) or check(0);
    local $/;
    my $bytes = <$file>;
    check(length($bytes) <= 8192);
    my $c = decode_json($bytes);
    check(join(',', sort keys %$c) eq
        'controllerGid,controllerUid,directory,memberId,perlHash,' .
        'relayHash,repositoryId,runnerId');
    for my $entry (['/usr/bin/perl', 'perlHash'],
        ['/opt/nibfin/core/src/mcp-job-relay.pl', 'relayHash']) {
        my ($name, $key) = @$entry;
        protected_path($name, 0, $key eq 'perlHash');
        check(realpath($name) eq $name && $c->{$key} =~ /^[a-f0-9]{64}$/);
        sysopen(my $program, $name, O_RDONLY | O_NOFOLLOW) or check(0);
        check(sha256_hex(<$program>) eq $c->{$key});
    }
    for my $key (qw(controllerGid controllerUid memberId repositoryId runnerId)) {
        check($c->{$key} =~ /^[1-9][0-9]*$/ && $c->{$key} < 9007199254740992);
    }
    check($c->{directory} eq '/run/nibfin-mcp');
    protected_path('/run', 1);
    protected_path($c->{directory}, 1);
    $path = "$c->{directory}/job.sock";
    $data_path = "$c->{directory}/response.sock";
    if (@ARGV) {
        my @s = lstat($data_path);
        check(@s && -S _ && !-l _ && $s[4] == 0 && ($s[2] & 0777) == 0600);
        my $payload = '';
        while (1) {
            my $count = sysread(STDIN, my $part, 8192);
            check(defined($count));
            last if $count == 0;
            $payload .= $part;
            check(length($payload) <= $limit);
        }
        check(length($payload) > 1);
        socket(my $upload, AF_UNIX, SOCK_STREAM, 0) or check(0);
        connect($upload, sockaddr_un($data_path)) or check(0);
        write_all($upload, $payload);
        shutdown($upload, SHUT_WR);
        my $ack = <$upload>;
        check(defined($ack) && $ack eq "NIBFIN_MCP_RESPONSE_STAGED\n");
        close($upload);
        print STDOUT $ack;
        return;
    }
    check(!-e $path && !-l $path);
    check(!-e $data_path && !-l $data_path);
    socket($data_server, AF_UNIX, SOCK_STREAM, 0) or check(0);
    umask(0077);
    bind($data_server, sockaddr_un($data_path)) or check(0);
    chmod(0600, $data_path) == 1 or check(0);
    listen($data_server, 1) or check(0);
    socket($server, AF_UNIX, SOCK_STREAM, 0) or check(0);
    bind($server, sockaddr_un($path)) or check(0);
    chown(0, $c->{controllerGid}, $path) == 1 or check(0);
    chmod(0660, $path) == 1 or check(0);
    listen($server, 1) or check(0);
    accept($peer, $server) or check(0);
    close($server);
    my $cred = getsockopt($peer, SOL_SOCKET, SO_PEERCRED);
    check(defined($cred) && length($cred) == 12);
    my ($pid, $uid, $gid) = unpack('iII', $cred);
    check($uid == $c->{controllerUid} && $gid == $c->{controllerGid});
    # The controller independently observes this exact relay PID disappear.
    write_all($peer, encode_json({ relayPid => $$ }) . "\n");
    my $request = '';
    while (index($request, "\n") < 0) {
        my $count = sysread($peer, my $part, 8192);
        check(defined($count) && $count > 0);
        $request .= $part;
        check(length($request) <= $limit);
    }
    check(index($request, "\n") == length($request) - 1);
    my $r = decode_json($request);
    check(join(',', sort keys %$r) eq 'binding,nonce,protocol');
    check($r->{protocol} eq 'nibfin-mcp-job-v1' &&
        $r->{nonce} =~ /^[a-f0-9]{64}$/);
    my $b = $r->{binding};
    validate_binding($b);
    for my $key (qw(memberId repositoryId runnerId)) {
        check($b->{$key} == $c->{$key});
    }
    write_all(\*STDOUT, $request);
    my $select = IO::Select->new($peer, \*STDIN, $data_server);
    my ($control, $response, $data_done, $uploader) = ('', '', 0, undef);
    my $proof = "NIBFIN_WINDOWS_MCP_OUTER_TERMINATED\n";
    my $control_done = 0;
    while (1) {
        for my $ready ($select->can_read(0.02)) {
            if (fileno($ready) == fileno($data_server)) {
                accept($data_peer, $data_server) or check(0);
                my $cred = getsockopt($data_peer, SOL_SOCKET, SO_PEERCRED);
                check(defined($cred) && length($cred) == 12);
                my ($pid, $uid, $gid) = unpack('iII', $cred);
                check($uid == 0 && $gid == 0 && $pid > 0);
                $uploader = $pid;
                $select->remove($data_server);
                $select->add($data_peer);
                next;
            }
            my $count = sysread($ready, my $part, 8192);
            check(defined($count));
            if (fileno($ready) == fileno($peer)) {
                check($count == 0);
                close(STDOUT); # Cancellation, never termination proof.
                # No response can be admitted after cancellation. Closing
                # request output asks the outer job to stop; exit is observed
                # independently and the endpoint remains for reconciliation.
                check(0);
            } elsif (fileno($ready) == fileno(STDIN)) {
                $control .= $part;
                check(length($control) <= length($proof));
                if ($count == 0) {
                    check($control eq $proof);
                    $control_done = 1;
                    $select->remove(\*STDIN);
                }
            } else {
                $response .= $part;
                check(length($response) <= $limit);
                if ($count == 0) {
                    check(length($response) > 1 &&
                        index($response, "\n") == length($response) - 1);
                    my $reply = decode_json($response);
                    check(ref($reply) eq 'HASH' &&
                        join(',', sort keys %$reply) eq
                        'binding,delegation,nonce,protocol,terminated' &&
                        ref($reply->{delegation}) eq 'HASH' &&
                        JSON::PP::is_bool($reply->{terminated}) && $reply->{terminated});
                    check($reply->{protocol} eq $r->{protocol} &&
                        $reply->{nonce} eq $r->{nonce});
                    validate_binding($reply->{binding});
                    for my $key (keys %$b) {
                        check($reply->{binding}{$key} == $b->{$key});
                    }
                    $reply->{nativeTerminated} = JSON::PP::true;
                    $response = encode_json($reply) . "\n";
                    write_all($data_peer, "NIBFIN_MCP_RESPONSE_STAGED\n");
                    $select->remove($data_peer);
                    close($data_peer);
                    $data_done = 1;
                }
            }
        }
        # The uploader is a separate Linux consumer; Windows wsl exit alone
        # is insufficient. Unknown/permission-denied observations fail closed.
        if ($control_done && $data_done) {
            last if !kill(0, $uploader) && $!{ESRCH};
        }
    }
    write_all($peer, $response);
    shutdown($peer, SHUT_WR);
    if ($select->exists($peer)) {
        my $count = sysread($peer, my $part, 1);
        check(defined($count) && $count == 0);
    }
    close($peer);
    close($data_server);
    unlink($data_path) == 1 or check(0);
    unlink($path) == 1 or check(0);
}
$SIG{PIPE} = 'IGNORE';
eval { main(); 1 } or do {
    # Unknown termination retains the endpoint for manual reconciliation.
    print STDERR "MCP_JOB_RELAY_UNRESOLVED\n";
    exit 1;
};
